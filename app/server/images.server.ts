import { imageSize } from "image-size";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { streamers } from "../../db/schema";
import type { AppEnv } from "../env";
import { assertStreamerWritable } from "./access.server";
import { HttpError, readBody } from "./http.server";
import { stripImageMetadata } from "./image-metadata";

const types: Readonly<Record<string, string>> = { png: "image/png", jpg: "image/jpeg", webp: "image/webp" };
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Account picture, page background and page logo use stable public addresses and immutable R2 versions. */
export const IMAGE_KINDS = ["avatar", "background", "logo"] as const;
export type ImageKind = (typeof IMAGE_KINDS)[number];

export function isImageKind(value: string): value is ImageKind {
  return (IMAGE_KINDS as readonly string[]).includes(value);
}

export function validateImage(bytes: Uint8Array, contentType: string | null): string {
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new HttpError(413, "Choose an image up to 5 MB.", "invalid_image");
  let dimensions: ReturnType<typeof imageSize>;
  try {
    dimensions = imageSize(bytes);
  } catch {
    throw new HttpError(400, "Choose a valid PNG, JPEG, or WebP image.", "invalid_image");
  }
  const mime = dimensions.type ? types[dimensions.type] : undefined;
  if (!mime || mime !== contentType) throw new HttpError(415, "Choose a PNG, JPEG, or WebP image.", "invalid_image");
  if (
    !dimensions.width ||
    !dimensions.height ||
    dimensions.width > 8192 ||
    dimensions.height > 8192 ||
    dimensions.width * dimensions.height > 16_000_000
  ) {
    throw new HttpError(400, "Choose an image up to 16 million pixels and 8192 pixels per side.");
  }
  return mime;
}

export async function uploadImage(request: Request, env: AppEnv, userId: string, kind: string): Promise<string> {
  if (!isImageKind(kind)) throw new HttpError(404, "Image type not found.");
  const db = drizzle(env.DB);
  const profile = (await db.select().from(streamers).where(eq(streamers.ownerId, userId)).limit(1))[0];
  if (kind !== "avatar") {
    // Page images belong to the page, so a frozen or suspended page cannot change them.
    if (!profile) throw new HttpError(403, "Create a streamer profile first.");
    await assertStreamerWritable(env, profile.id, userId);
  }
  const bytes = await readBody(request, MAX_IMAGE_BYTES);
  const contentType = validateImage(bytes, request.headers.get("Content-Type"));
  const clean: Uint8Array = stripImageMetadata(bytes, contentType);
  const path = `${kind}/${userId}`;
  const previous = await imageStorageKey(env, userId, kind);
  const version = crypto.randomUUID();
  const key = `${path}/${version}`;
  const url = `/images/${path}`;
  await env.IMAGES.put(key, clean, { httpMetadata: { contentType, cacheControl: "no-cache" } });
  const publish = env.DB.prepare(
    "INSERT INTO image_versions (owner_id,kind,version) VALUES (?,?,?) ON CONFLICT(owner_id,kind) DO UPDATE SET version=excluded.version",
  ).bind(userId, kind, version);
  if (kind === "avatar") {
    await env.DB.batch([
      env.DB.prepare("UPDATE user SET image = ?, updated_at = ? WHERE id = ?").bind(url, Date.now(), userId),
      env.DB.prepare("UPDATE streamers SET avatar = ? WHERE owner_id = ?").bind(url, userId),
      publish,
    ]);
  } else {
    await env.DB.batch([env.DB.prepare(`UPDATE streamers SET ${kind}=? WHERE owner_id=?`).bind(url, userId), publish]);
  }
  try {
    await env.IMAGES.delete(previous);
  } catch (error: unknown) {
    console.error("Previous image cleanup failed.", { cause: error instanceof Error ? error.name : "unknown" });
  }
  return url;
}

/**
 * `DELETE /api/images/avatar`: drops the uploaded profile picture (the profile dialog does this when a preset is
 * chosen, because an upload wins over a preset). The page keeps working: its logo falls back to the preset.
 */
export async function deleteAvatar(env: AppEnv, userId: string): Promise<void> {
  const url = `/images/avatar/${userId}`;
  const key = await imageStorageKey(env, userId, "avatar");
  await env.DB.batch([
    env.DB.prepare("UPDATE user SET image = NULL, updated_at = ? WHERE id = ? AND image = ?").bind(
      Date.now(),
      userId,
      url,
    ),
    env.DB.prepare("UPDATE streamers SET avatar = NULL WHERE owner_id = ? AND avatar = ?").bind(userId, url),
  ]);
  await env.IMAGES.delete([...new Set([key, `avatar/${userId}`])]);
}

/** `DELETE /api/images/logo`: the page goes back to the owner's profile picture. */
export async function deleteLogo(env: AppEnv, userId: string): Promise<void> {
  const db = drizzle(env.DB);
  const profile = (await db.select().from(streamers).where(eq(streamers.ownerId, userId)).limit(1))[0];
  if (!profile) throw new HttpError(403, "Create a streamer profile first.");
  await assertStreamerWritable(env, profile.id, userId);
  const key = await imageStorageKey(env, userId, "logo");
  await db.update(streamers).set({ logo: null }).where(eq(streamers.id, profile.id));
  await env.IMAGES.delete([...new Set([key, `logo/${userId}`])]);
}

export async function imageStorageKey(env: AppEnv, userId: string, kind: ImageKind): Promise<string> {
  const row = await env.DB.prepare("SELECT version FROM image_versions WHERE owner_id=? AND kind=?")
    .bind(userId, kind)
    .first<{ version: string }>();
  const path = `${kind}/${userId}`;
  return row ? `${path}/${row.version}` : path;
}

export async function deleteImageObjects(env: AppEnv, userId: string, kind: ImageKind): Promise<void> {
  const path = `${kind}/${userId}`;
  await env.IMAGES.delete(path);
  let cursor: string | undefined;
  do {
    const page = await env.IMAGES.list({ prefix: `${path}/`, cursor });
    if (page.objects.length) await env.IMAGES.delete(page.objects.map((object) => object.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

async function openImageCache(): Promise<Pick<Cache, "match" | "put"> | undefined> {
  if (typeof caches === "undefined") return undefined;
  try {
    return await caches.open("public-images");
  } catch (error: unknown) {
    console.error("Image cache open failed.", { cause: error instanceof Error ? error.name : "unknown" });
    return undefined;
  }
}

async function matchImageCache(cache: Pick<Cache, "match">, key: string): Promise<Response | undefined> {
  try {
    return await cache.match(key);
  } catch (error: unknown) {
    console.error("Image cache lookup failed.", { cause: error instanceof Error ? error.name : "unknown" });
    return undefined;
  }
}

async function writeImageCache(cache: Pick<Cache, "put">, key: string, response: Response): Promise<void> {
  try {
    await cache.put(key, response.clone());
  } catch (error: unknown) {
    console.error("Image cache write failed.", { cause: error instanceof Error ? error.name : "unknown" });
  }
}

async function readImageResponse(
  env: AppEnv,
  path: string,
  version: string | null,
  cache: Pick<Cache, "match" | "put"> | undefined,
): Promise<Response | null> {
  const key: string | null =
    version && cache ? `${env.APP_ORIGIN}/images/${path}?version=${encodeURIComponent(version)}` : null;
  if (key && cache) {
    const response: Response | undefined = await matchImageCache(cache, key);
    if (response) return response;
  }
  const object = await env.IMAGES.get(version ? `${path}/${version}` : path);
  if (!object) return null;
  const response = new Response(object.body, {
    headers: {
      "Cache-Control": "public, max-age=3600",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "X-Content-Type-Options": "nosniff",
      "Content-Type": object.httpMetadata?.contentType ?? "application/octet-stream",
      ETag: object.httpEtag,
    },
  });
  if (key && cache) {
    await writeImageCache(cache, key, response);
  }
  return response;
}

export async function serveImage(
  env: AppEnv,
  path: string,
  method: string,
  cache?: Pick<Cache, "match" | "put">,
): Promise<Response> {
  if (!/^(avatar|background|logo)\/[a-zA-Z0-9_-]{1,128}$/.test(path)) throw new HttpError(404, "Image not found.");
  const [kind, userId] = path.split("/");
  const url = `/images/${path}`;
  const reference =
    kind === "avatar"
      ? env.DB.prepare(`SELECT v.version FROM user u LEFT JOIN image_versions v
          ON v.owner_id=u.id AND v.kind=? WHERE u.id=? AND u.image=?`).bind(kind, userId, url)
      : env.DB.prepare(`SELECT v.version FROM streamers s LEFT JOIN image_versions v
          ON v.owner_id=s.owner_id AND v.kind=? WHERE s.owner_id=? AND s.${kind}=?`).bind(kind, userId, url);
  let retry = true;
  for (;;) {
    const live = await reference.first<{ version: string | null }>();
    if (!live) throw new HttpError(404, "Image not found.");
    if (live.version && !cache) cache = await openImageCache();
    const response: Response | null = await readImageResponse(env, path, live.version, cache);
    if (!response && retry) {
      retry = false;
      continue;
    }
    if (!response) throw new HttpError(404, "Image not found.");
    const headers = new Headers(response.headers);
    headers.set("Cache-Control", "no-store");
    return new Response(method === "HEAD" ? null : response.body, { headers });
  }
}
