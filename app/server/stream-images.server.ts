import type { AppEnv } from "../env";
import { STREAM_IMAGE_URL } from "./channel-providers.server";
import { HttpError, logError, readBody } from "./http.server";

/**
 * The pictures of scheduled streams: a YouTube thumbnail or a Twitch category cover. The schedule import downloads
 * each picture once and keeps a small copy in R2 under `schedule/<page>/<picture>-<size>`, `<picture>` being a hash
 * of its address: streams that share a cover share one copy, and a changed thumbnail has a new address. The image route serves only these copies, so the devices of viewers
 * never contact the Twitch or YouTube image hosts.
 */
const PREFIX = "schedule/";
const SOURCE_TYPES: ReadonlySet<string> = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_SOURCE_BYTES = 5 * 1024 * 1024;
/** Downloads in one read at most: a page lists a stream a day for 4 weeks on two platforms. */
const MAX_DOWNLOADS = 60;
/**
 * No download starts later than this after the read: a read after a visit runs in `waitUntil`, which ends 30 seconds
 * after the response. A picture that does not fit waits for the next read.
 */
const DOWNLOAD_WINDOW_MS = 20_000;
/** The sweep keeps a copy younger than this: a read that runs at the same time can have stored it for a new source. */
const SWEEP_GRACE_MS = 3_600_000;

type Size = "large" | "small";
/** A YouTube thumbnail for the "Up next" card and for a schedule row. A Twitch cover comes in its size already. */
const THUMBNAIL_SIZES: Readonly<Record<Size, { width: number; height: number }>> = {
  large: { width: 960, height: 540 },
  small: { width: 320, height: 180 },
};

interface SourceRow {
  streamer_id: string;
  platform: string;
  external_id: string;
  image_url: string;
}

async function pictureBase(row: Pick<SourceRow, "streamer_id" | "image_url">): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(row.image_url));
  const hash = Array.from(new Uint8Array(digest, 0, 16), (byte: number) => byte.toString(16).padStart(2, "0")).join("");
  return `${PREFIX}${row.streamer_id}/${hash}`;
}

/** The picture at `url`, or null when the host does not answer with an image. Never logs the address. */
async function download(url: string): Promise<{ bytes: Uint8Array<ArrayBuffer>; type: string } | null> {
  try {
    // Workers refuse `redirect: "error"` before sending; a redirect answer is not `ok`, so it fails below.
    const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(5000) });
    const type = response.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase() ?? "";
    if (!response.ok || !SOURCE_TYPES.has(type)) {
      console.warn("stream_image_download_failed", { status: response.status, type });
      await response.body?.cancel();
      return null;
    }
    return { bytes: await readBody(response, MAX_SOURCE_BYTES), type };
  } catch (error: unknown) {
    console.warn("stream_image_download_failed", { error: error instanceof Error ? error.name : "unknown" });
    return null;
  }
}

async function resized(env: AppEnv, bytes: Uint8Array<ArrayBuffer>, size: Size): Promise<ArrayBuffer> {
  if (!env.IMAGE_TRANSFORM) throw new Error("The Images binding is missing.");
  const input = new Blob([bytes]).stream();
  const result = await env.IMAGE_TRANSFORM.input(input)
    .transform({ ...THUMBNAIL_SIZES[size], fit: "cover" })
    .output({ format: "image/webp", quality: 80 });
  return await result.response().arrayBuffer();
}

/** The copies a picture needs: a Twitch cover has one, a YouTube thumbnail two. */
function sizesOf(platform: string): readonly Size[] {
  return platform === "twitch" ? ["large"] : ["small", "large"];
}

/** Stores one picture unless all its copies exist. Takes one download from `budget` before it loads. */
async function storeOne(
  env: AppEnv,
  row: SourceRow,
  done: Set<string>,
  budget: { left: number; until: number },
): Promise<void> {
  // Without the Images binding (the test deployment), a thumbnail cannot become small: it is not loaded.
  if (row.platform !== "twitch" && !env.IMAGE_TRANSFORM) return;
  const base = await pictureBase(row);
  if (done.has(base)) return;
  done.add(base);
  const present = await Promise.all(sizesOf(row.platform).map((size: Size) => env.IMAGES.head(`${base}-${size}`)));
  if (present.every(Boolean) || budget.left <= 0 || Date.now() > budget.until) return;
  budget.left -= 1;
  const picture = await download(row.image_url);
  if (!picture) return;
  if (row.platform === "twitch") {
    await env.IMAGES.put(`${base}-large`, picture.bytes, { httpMetadata: { contentType: picture.type } });
    return;
  }
  for (const size of sizesOf(row.platform)) {
    await env.IMAGES.put(`${base}-${size}`, await resized(env, picture.bytes, size), {
      httpMetadata: { contentType: "image/webp" },
    });
  }
}

/** After a read of a page: stores the pictures that are new or changed. A failed picture never fails the read. */
export async function storeStreamImages(env: AppEnv, streamerId: string, start: number = Date.now()): Promise<void> {
  const { results } =
    await env.DB.prepare(`SELECT streamer_id, platform, external_id, image_url FROM stream_event_sources
      WHERE streamer_id=? AND image_url IS NOT NULL AND event_id IS NOT NULL ORDER BY read_at DESC`)
      .bind(streamerId)
      .all<SourceRow>();
  const done = new Set<string>();
  const budget = { left: MAX_DOWNLOADS, until: start + DOWNLOAD_WINDOW_MS };
  for (const row of results) {
    if (!STREAM_IMAGE_URL.test(row.image_url)) continue;
    try {
      await storeOne(env, row, done, budget);
    } catch (error: unknown) {
      logError("stream_image_store_failed", error);
    }
  }
}

/**
 * Hourly: deletes the stored copies that no source links to any more and that are older than an hour, so a copy
 * that a parallel read just stored for a new source stays. Returns how many went.
 */
export async function sweepStreamImages(env: AppEnv, now: number = Date.now()): Promise<number> {
  const { results } = await env.DB.prepare(
    "SELECT DISTINCT streamer_id, image_url FROM stream_event_sources WHERE image_url IS NOT NULL",
  ).all<Pick<SourceRow, "streamer_id" | "image_url">>();
  const keep = new Set<string>(await Promise.all(results.map((row) => pictureBase(row))));
  const stale: string[] = [];
  let cursor: string | undefined;
  do {
    const listed = await env.IMAGES.list({ prefix: PREFIX, cursor, limit: 1000 });
    for (const object of listed.objects) {
      const young = object.uploaded.getTime() > now - SWEEP_GRACE_MS;
      if (!young && !keep.has(object.key.replace(/-(large|small)$/, ""))) stale.push(object.key);
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  for (let index = 0; index < stale.length; index += 1000) await env.IMAGES.delete(stale.slice(index, index + 1000));
  return stale.length;
}

/**
 * `GET /images/stream/<event>/<platform>[/small]`: the stored picture of a scheduled stream. `small` is the copy for
 * a schedule row; a Twitch cover has one size.
 */
export async function serveStreamImage(env: AppEnv, path: string, method: string): Promise<Response> {
  const match = /^([0-9a-f-]{36})\/(twitch|youtube)(\/small)?$/.exec(path);
  if (!match) throw new HttpError(404, "Image not found.");
  const row = await env.DB.prepare(`SELECT streamer_id, image_url FROM stream_event_sources
      WHERE event_id=? AND platform=? AND image_url IS NOT NULL`)
    .bind(match[1], match[2])
    .first<Pick<SourceRow, "streamer_id" | "image_url">>();
  if (!row) throw new HttpError(404, "Image not found.");
  const size: Size = match[3] && match[2] === "youtube" ? "small" : "large";
  const object = await env.IMAGES.get(`${await pictureBase(row)}-${size}`);
  if (!object) throw new HttpError(404, "Image not found.");
  return new Response(method === "HEAD" ? null : object.body, {
    headers: {
      "Content-Type": object.httpMetadata?.contentType ?? "application/octet-stream",
      // A new thumbnail keeps the route address: browsers check again after 10 minutes.
      "Cache-Control": "public, max-age=600",
      ETag: object.httpEtag,
    },
  });
}
