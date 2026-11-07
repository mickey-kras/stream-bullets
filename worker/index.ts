import { createRequestHandler, RouterContextProvider } from "react-router";
import { appContext, type AppEnv } from "../app/env";
import { isStreamerListed } from "../app/server/access.server";
import { getViewer } from "../app/server/auth.server";
import { getStreamer } from "../app/server/data.server";
import {
  HttpError,
  errorResponse,
  getOrigin,
  queryParams,
  requireSameOrigin,
  securityHeaders,
} from "../app/server/http.server";
import { serveImage } from "../app/server/images.server";
import { cleanExpiredData } from "../app/server/cleanup.server";
import { scheduleCalendar, topUpSeries } from "../app/server/schedule.server";

export { PollRoom } from "../app/server/poll-room";

/** The hex SHA-256 of a string. */
async function sha256(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (byte: number) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * The network a live connection comes from: an IPv4 address as is, an IPv6 address cut to its /64. One host usually
 * holds a whole IPv6 /64, so the per-client socket cap counts the /64, not each address in it.
 */
function clientNetwork(ip: string): string {
  if (!ip.includes(":")) return ip;
  const address: string = ip.split("%")[0].toLowerCase();
  const [head, tail] = address.split("::");
  const groups = (part: string | undefined): string[] => (part ? part.split(":") : []);
  const front: string[] = groups(head);
  // An IPv4 tail (::ffff:192.0.2.1) is two groups, and only the last 32 bits, so it never changes the /64.
  const back: string[] = groups(tail).flatMap((group: string): string[] =>
    group.includes(".") ? ["0", "0"] : [group],
  );
  const missing: number = tail === undefined ? 0 : Math.max(0, 8 - front.length - back.length);
  const full: string[] = [...front, ...Array.from({ length: missing }, (): string => "0"), ...back];
  return `${full
    .slice(0, 4)
    .map((group: string): string => Number.parseInt(group || "0", 16).toString(16))
    .join(":")}::/64`;
}

/** The key the live room counts sockets by: the hashed client network. */
async function liveClientKey(ip: string): Promise<string> {
  return sha256(clientNetwork(ip));
}

const handler = createRequestHandler(() => import("virtual:react-router/server-build"), import.meta.env.MODE);

export default {
  async scheduled(controller: ScheduledController, env: AppEnv): Promise<void> {
    await cleanExpiredData(env, controller.scheduledTime);
    // Weekly series are written 12 weeks ahead; keep them topped up.
    await topUpSeries(env, controller.scheduledTime);
  },
  async fetch(request: Request, env: AppEnv): Promise<Response> {
    const nonce = btoa(String.fromCodePoint(...crypto.getRandomValues(new Uint8Array(18))));
    const responseHeaders = new Headers();
    let response: Response;
    let origin: string;
    try {
      origin = getOrigin(env);
      if (new URL(request.url).origin !== origin) throw new HttpError(421, "Use the configured application URL.");
      const keyBytes = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(request.headers.get("CF-Connecting-IP") ?? "local"),
      );
      const key = Array.from(new Uint8Array(keyBytes), (byte: number) => byte.toString(16).padStart(2, "0")).join("");
      if (!(await env.REQUEST_LIMITER.limit({ key })).success)
        throw new HttpError(429, "Too many requests. Please try again in a minute.");
      const path = new URL(request.url).pathname;
      const live = /^\/api\/live\/([a-z0-9_]{3,30})$/.exec(path);
      const calendar = /^\/@([a-z0-9_]{3,30})\/schedule\.ics$/.exec(path);
      if (calendar) {
        if (!["GET", "HEAD"].includes(request.method)) throw new HttpError(405, "Method not allowed.");
        queryParams(request, []);
        const streamer = await getStreamer(env, calendar[1]);
        // Suspended pages have no public calendar, the owner's included.
        if (!streamer || !isStreamerListed(streamer.status)) throw new HttpError(404, "Streamer not found.");
        const body = await scheduleCalendar(env, streamer, origin);
        response = new Response(request.method === "HEAD" ? null : body, {
          headers: {
            "Content-Type": "text/calendar; charset=utf-8",
            "Content-Disposition": `inline; filename="${streamer.handle}-schedule.ics"`,
            "Cache-Control": "public, max-age=300",
          },
        });
      } else if (live) {
        requireSameOrigin(request, env);
        queryParams(request, []);
        if (request.method !== "GET" || request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
          throw new HttpError(426, "Use a WebSocket connection.");
        const streamer = await getStreamer(env, live[1]);
        // Suspended pages refuse live connections, the owner's included.
        if (!streamer || !isStreamerListed(streamer.status)) throw new HttpError(404, "Streamer not found.");
        // The room trusts only these headers for who taps in a Mash Battle and who owns the page; a client-sent copy
        // never reaches it.
        const viewer = await getViewer(request, { env, nonce, responseHeaders });
        const headers = new Headers({
          Upgrade: "websocket",
          "X-Stream-Bullets-Client": await liveClientKey(request.headers.get("CF-Connecting-IP") ?? "local"),
        });
        if (viewer) headers.set("X-SB-User", viewer.id);
        if (viewer && viewer.id === streamer.ownerId) headers.set("X-SB-Owner", "1");
        const room = env.POLL_ROOMS.get(env.POLL_ROOMS.idFromName(streamer.id));
        response = await room.fetch(
          `https://poll-room.internal/subscribe?streamerId=${encodeURIComponent(streamer.id)}`,
          { headers },
        );
      } else if (path.startsWith("/images/")) {
        if (!["GET", "HEAD"].includes(request.method)) throw new HttpError(405, "Method not allowed.");
        response = await serveImage(env, path.slice("/images/".length), request.method);
      } else {
        const context = new RouterContextProvider();
        context.set(appContext, { env, nonce, responseHeaders });
        response = await handler(request, context);
      }
    } catch (error) {
      response = errorResponse(error);
      origin = "https://invalid.invalid";
    }
    const secured = securityHeaders(response, request, nonce, origin, import.meta.env.DEV);
    for (const value of responseHeaders.getSetCookie()) secured.headers.append("Set-Cookie", value);
    return secured;
  },
} satisfies ExportedHandler<AppEnv>;
