import { sitemapResponse } from "../app/server/sitemap.server";
import { createRequestHandler, RouterContextProvider } from "react-router";
import { appContext, type AppContext, type AppEnv } from "../app/env";
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
import { serveStreamImage } from "../app/server/stream-images.server";
import { overlayKeyMatches } from "../app/server/overlay-key.server";
import { KEY_REFUSED_CLOSE } from "../app/lib/activity-socket";
import { visitorPrefix } from "../app/server/ip-prefix";
import { cleanExpiredData } from "../app/server/cleanup.server";
import { TRANSLATION_CRON, translatePending } from "../app/server/translation-jobs.server";
import { importSchedules } from "../app/server/schedule-import.server";
import { scheduleCalendar, topUpSeries } from "../app/server/schedule.server";
import {
  requireTestAccess,
  requireTestDatabase,
  testEnvironmentResponse,
  validateTestEnvironment,
} from "../app/server/test-environment.server";

import {
  WebhookRejected,
  kickWebhook,
  logRejectedWebhook,
  recordRejectedWebhook,
  twitchWebhook,
} from "../app/server/channel-webhooks.server";
import { channelsOff } from "../app/server/channel-tokens.server";
import { expireYoutubeConnections, repairChannelSubscriptions } from "../app/server/channels.server";
import { callIngest } from "../app/server/ingest-call.server";

export { PollRoom } from "../app/server/poll-room";
export { ChannelIngest } from "../app/server/channel-ingest";

async function sha256(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (byte: number) => byte.toString(16).padStart(2, "0")).join("");
}

// Hash an IPv4 address or IPv6 /64; IPv4-mapped IPv6 counts as IPv4.
async function clientKey(request: Request): Promise<string> {
  return sha256(visitorPrefix(request.headers.get("CF-Connecting-IP") ?? "local"));
}

const BINARY_LABELS_COMPATIBILITY_HEADER: string = "X-StreamBullets-Binary-Labels";
const BINARY_LABELS_COMPATIBILITY_VERSION: string = "1";

type QuotaScope = "auth" | "connect" | "write" | "private-read";

const READ_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);
const PRIVATE_READ_PATH: RegExp = /^\/api\/(admin(?:\/|$)|account\/export$)/;

// The router decodes and ignores letter case, and its data URLs reach the same loader as the document path.
// Apply the same rules, so that an encoded, upper-case, or `.data` URL cannot select a different quota.
function admissionPath(path: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    throw new HttpError(400, "Invalid URL path.");
  }
  return decoded
    .toLowerCase()
    .replaceAll("%2f", "/")
    .replace(/\/_\.data$/, "/")
    .replace(/\.data$/, "");
}

// Reads of public pages, API data, and images use no per-address quota, so one busy shared address cannot lock its
// users out of them. Each abuse-sensitive request kind has its own budget. Writes and exports also have account
// quotas in their handlers.
function quotaScope(request: Request, path: string): QuotaScope | null {
  const normalized: string = admissionPath(path);
  if (normalized.startsWith("/api/auth/")) return "auth";
  if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") return "connect";
  if (!READ_METHODS.has(request.method)) return "write";
  if (PRIVATE_READ_PATH.test(normalized)) return "private-read";
  return null;
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

/**
 * The page's activity feed (docs/channel-connections.md): only an OBS source with the current overlay key, or the
 * signed-in owner, may listen. The key grants this read-only feed and the live room, nothing else.
 */
async function activityResponse(
  request: Request,
  env: AppEnv,
  handle: string,
  nonce: string,
  responseHeaders: Headers,
): Promise<Response> {
  requireSameOrigin(request, env);
  const params: URLSearchParams = queryParams(request, ["key", "characters"]);
  const overlayKey: string | null = params.get("key");
  // `characters=1` also asks for the character playground frames.
  const characters: string | null = params.get("characters");
  if (characters !== null && characters !== "1") throw new HttpError(400, "Invalid query parameters.");
  if (request.method !== "GET" || request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
    throw new HttpError(426, "Use a WebSocket connection.");
  const streamer = await getStreamer(env, handle);
  if (!streamer || !isStreamerListed(streamer.status)) throw new HttpError(404, "Streamer not found.");
  const headers = new Headers({ Upgrade: "websocket" });
  if (await overlayKeyMatches(env, streamer.id, overlayKey)) headers.set("X-SB-Overlay", "1");
  else if ((await getViewer(request, { env, nonce, responseHeaders }))?.id === streamer.ownerId)
    headers.set("X-SB-Owner", "1");
  else if (overlayKey === null) throw new HttpError(403, "Use the overlay URL with its key.");
  else return keyRefused();
  return callIngest(env, streamer.id, "subscribe", { init: { headers }, characters: characters === "1" });
}

/**
 * A wrong or revoked overlay key: accept the socket and close it with KEY_REFUSED_CLOSE. A browser cannot read the
 * status of a failed upgrade, so only a close code tells the overlay page to stop its retries.
 */
function keyRefused(): Response {
  const [client, server] = Object.values(new WebSocketPair());
  server.accept();
  server.close(KEY_REFUSED_CLOSE, "Overlay key refused");
  return new Response(null, { status: 101, webSocket: client });
}

async function webhookResponse(request: Request, env: AppEnv, path: string, key: string): Promise<Response> {
  const platform: "twitch" | "kick" = path === "/hooks/twitch" ? "twitch" : "kick";
  try {
    // A repeated Kick message id counts against the limit too (see kickWebhook).
    const countRepeat = async (): Promise<void> => {
      if (!(await env.REQUEST_LIMITER.limit({ key })).success)
        throw new HttpError(429, "Too many requests. Please try again in a minute.");
    };
    return platform === "twitch"
      ? await twitchWebhook(request, env)
      : await kickWebhook(request, env, Date.now(), countRepeat);
  } catch (error: unknown) {
    logRejectedWebhook(platform, error);
    await recordRejectedWebhook(env, platform, error);
    if (error instanceof WebhookRejected && error.forged && !(await env.REQUEST_LIMITER.limit({ key })).success)
      throw new HttpError(429, "Too many requests. Please try again in a minute.");
    throw error;
  }
}

/**
 * A plain-HTTP read of the application host goes to the same address on HTTPS. Link checkers, such as the one for
 * the Google consent screen, start with HTTP. Another host or port gets no redirect.
 */
export function httpsRedirect(request: Request, origin: string): Response | null {
  const url = new URL(request.url);
  const target = new URL(origin);
  const read: boolean = request.method === "GET" || request.method === "HEAD";
  if (!read || url.protocol !== "http:" || target.protocol !== "https:" || url.host !== target.host) return null;
  return new Response(null, { status: 301, headers: { Location: `${origin}${url.pathname}${url.search}` } });
}

function secured(
  response: Response,
  request: Request,
  env: AppEnv,
  context: Readonly<{ nonce: string; origin: string; requestId: string; responseHeaders: Headers }>,
): Response {
  const result: Response = securityHeaders(response, request, context.nonce, context.origin, import.meta.env.DEV);
  if (env.APP_ENV === "test") result.headers.set("X-Robots-Tag", "noindex, nofollow");
  result.headers.set("X-Request-ID", context.requestId);
  result.headers.set(BINARY_LABELS_COMPATIBILITY_HEADER, BINARY_LABELS_COMPATIBILITY_VERSION);
  for (const value of context.responseHeaders.getSetCookie()) result.headers.append("Set-Cookie", value);
  return result;
}

async function imageResponse(request: Request, env: AppEnv, path: string): Promise<Response> {
  if (!["GET", "HEAD"].includes(request.method)) throw new HttpError(405, "Method not allowed.");
  const image: Response = path.startsWith("/images/stream/")
    ? await serveStreamImage(env, path.slice("/images/stream/".length), request.method)
    : await serveImage(env, path.slice("/images/".length), request.method);
  // The test environment serves images only behind its access cookie.
  if (env.APP_ENV === "test") image.headers.set("Cache-Control", "private, no-cache");
  return image;
}

async function routeResponse(
  request: Request,
  path: string,
  key: string,
  context: AppContext,
  origin: string,
): Promise<Response> {
  const { env, nonce, responseHeaders } = context;
  const live = /^\/api\/live\/([a-z0-9_]{3,30})$/.exec(path);
  const activity = /^\/api\/activity\/([a-z0-9_]{3,30})$/.exec(path);
  const calendar = /^\/@([a-z0-9_]{3,30})\/schedule\.ics$/.exec(path);
  if (path === "/__test") {
    return await testEnvironmentResponse(request, env);
  } else if (path === "/hooks/kick" && channelsOff(env)) {
    // Ingestion is off: acknowledge and drop, so Kick does not retry. Twitch still reports revocations.
    return new Response(null, { status: 204 });
  } else if (path === "/hooks/twitch" || path === "/hooks/kick") {
    return await webhookResponse(request, env, path, key);
  } else if (activity) {
    if (channelsOff(env)) throw new HttpError(503, "The activity feed is off.");
    return await activityResponse(request, env, activity[1], nonce, responseHeaders);
  } else if (path === "/sitemap.xml") {
    return await sitemapResponse(request, env);
  } else if (calendar) {
    return await calendarResponse(request, env, calendar[1], origin);
  } else if (live) {
    return await liveResponse(request, env, live[1], key, nonce, responseHeaders);
  } else if (path.startsWith("/images/")) {
    return await imageResponse(request, env, path);
  } else {
    const routerContext = new RouterContextProvider();
    routerContext.set(appContext, context);
    return await handler(request, routerContext);
  }
}

export default {
  // Run hourly jobs independently. Log each failure, then throw so cron failure alerts fire.
  async scheduled(controller: ScheduledController, env: AppEnv): Promise<void> {
    validateTestEnvironment(env);
    if (env.APP_ENV === "test") await requireTestDatabase(env);
    // This trigger only translates content. A failure of all its work fails the run, so the cron alert shows it.
    if (controller.cron === TRANSLATION_CRON) {
      await translatePending(env, controller.scheduledTime);
      return;
    }
    const jobs: Record<string, (env: AppEnv, now: number) => Promise<unknown>> = {
      cleanup: cleanExpiredData,
      // Keep weekly series 12 weeks ahead.
      schedule_top_up: topUpSeries,
      // Stored YouTube API data must not outlive its refresh window.
      youtube_expiry: expireYoutubeConnections,
      // Twitch and Kick subscriptions that the provider ended are created again.
      channel_repair: repairChannelSubscriptions,
      // Scheduled streams of connected Twitch and YouTube channels.
      schedule_import: importSchedules,
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
      validateTestEnvironment(env);
      origin = getOrigin(env);
      const secure: Response | null = httpsRedirect(request, origin);
      if (secure) return secured(secure, request, env, { nonce, origin, requestId, responseHeaders });
      if (new URL(request.url).origin !== origin) throw new HttpError(421, "Use the configured application URL.");
      const path = new URL(request.url).pathname;
      const key = await clientKey(request);
      // Provider webhooks come from a few shared provider addresses, so the per-address limit would drop real
      // deliveries. Only a failed check that a forger causes (a bad signature, size, method or query) counts against
      // the limit. A stale or unparsable signed Twitch delivery does not: only Twitch has our secret. For Kick, a
      // stale or unparsable copy and a repeated message id do count: Kick signs every app's webhooks with one key.
      // A forged request still costs a body read and a signature check. The ingest object's admission buckets
      // bound signed deliveries.
      const hook = path === "/hooks/twitch" || path === "/hooks/kick";
      const scope: QuotaScope | null = hook ? null : quotaScope(request, path);
      if (scope && !(await env.REQUEST_LIMITER.limit({ key: `${scope}:${key}` })).success)
        throw new HttpError(429, "Too many requests. Please try again in a minute.");
      if (path !== "/__test") await requireTestAccess(request, env);
      response = await routeResponse(request, path, key, { env, nonce, responseHeaders, requestId }, origin);
    } catch (error) {
      response = errorResponse(error, request, requestId);
      origin = "https://invalid.invalid";
    }
    return secured(response, request, env, { nonce, origin, requestId, responseHeaders });
  },
} satisfies ExportedHandler<AppEnv>;
