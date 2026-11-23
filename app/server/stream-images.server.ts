import type { AppEnv } from "../env";
import { STREAM_IMAGE_URL } from "./channel-providers.server";
import { HttpError, readBody } from "./http.server";

const IMAGE_TYPES: ReadonlySet<string> = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

/**
 * `GET /images/stream/<event>/<platform>`: the picture that the schedule import stored for a scheduled stream, a
 * YouTube thumbnail or a Twitch category cover. The server loads it, so the devices of viewers never contact the
 * Twitch or YouTube image hosts. Cloudflare keeps the loaded image for a day.
 */
export async function serveStreamImage(env: AppEnv, path: string, method: string): Promise<Response> {
  const match = /^([0-9a-f-]{36})\/(twitch|youtube)$/.exec(path);
  if (!match) throw new HttpError(404, "Image not found.");
  const row = await env.DB.prepare("SELECT image_url FROM stream_event_sources WHERE event_id=? AND platform=?")
    .bind(match[1], match[2])
    .first<{ image_url: string | null }>();
  const source = row?.image_url;
  if (!source || !STREAM_IMAGE_URL.test(source)) throw new HttpError(404, "Image not found.");
  let bytes: Uint8Array<ArrayBuffer>;
  let type: string;
  try {
    const response = await fetch(source, {
      redirect: "error",
      signal: AbortSignal.timeout(5000),
      cf: { cacheTtl: 86_400, cacheEverything: true },
    });
    type = response.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase() ?? "";
    if (!response.ok || !IMAGE_TYPES.has(type)) throw new Error("not an image");
    bytes = await readBody(response, MAX_IMAGE_BYTES);
  } catch (error: unknown) {
    // Provider URLs stay out of the log.
    console.warn("stream_image_failed", error instanceof DOMException ? "network_or_timeout" : "response");
    throw new HttpError(404, "Image not found.");
  }
  return new Response(method === "HEAD" ? null : bytes, {
    headers: { "Content-Type": type, "Cache-Control": "public, max-age=3600" },
  });
}
