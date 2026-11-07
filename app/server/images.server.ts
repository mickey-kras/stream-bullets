import { imageSize } from "image-size";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { streamers } from "../../db/schema";
import type { AppEnv } from "../env";
import { assertStreamerWritable } from "./access.server";
import { HttpError, readBody } from "./http.server";

const types: Readonly<Record<string, string>> = { png: "image/png", jpg: "image/jpeg", webp: "image/webp" };
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Account picture, page background and page logo. Each lives in R2 at `{kind}/{userId}`. */
export const IMAGE_KINDS = ["avatar", "background", "logo"] as const;
export type ImageKind = (typeof IMAGE_KINDS)[number];

export function isImageKind(value: string): value is ImageKind {
  return (IMAGE_KINDS as readonly string[]).includes(value);
}

export function validateImage(bytes: Uint8Array, contentType: string | null): string {
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new HttpError(413, "Choose an image up to 5 MB.");
  let dimensions: ReturnType<typeof imageSize>;
  try {
    dimensions = imageSize(bytes);
  } catch {
    throw new HttpError(400, "Choose a valid PNG, JPEG, or WebP image.");
  }
  const mime = dimensions.type ? types[dimensions.type] : undefined;
  if (!mime || mime !== contentType) throw new HttpError(415, "Choose a PNG, JPEG, or WebP image.");
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
  const key = `${kind}/${userId}`;
  const url = `/images/${key}`;
  await env.IMAGES.put(key, bytes, { httpMetadata: { contentType, cacheControl: "no-cache" } });
  if (kind === "avatar") {
    await env.DB.batch([
      env.DB.prepare("UPDATE user SET image = ?, updated_at = ? WHERE id = ?").bind(url, Date.now(), userId),
      env.DB.prepare("UPDATE streamers SET avatar = ? WHERE owner_id = ?").bind(url, userId),
    ]);
  } else if (kind === "logo") {
    await db.update(streamers).set({ logo: url }).where(eq(streamers.ownerId, userId));
  } else {
    await db.update(streamers).set({ background: url }).where(eq(streamers.ownerId, userId));
  }
  return url;
}

/**
 * `DELETE /api/images/avatar`: drops the uploaded profile picture (the profile dialog does this when a preset is
 * chosen, because an upload wins over a preset). The page keeps working: its logo falls back to the preset.
 */
export async function deleteAvatar(env: AppEnv, userId: string): Promise<void> {
  const url = `/images/avatar/${userId}`;
  await env.DB.batch([
    env.DB.prepare("UPDATE user SET image = NULL, updated_at = ? WHERE id = ? AND image = ?").bind(
      Date.now(),
      userId,
      url,
    ),
    env.DB.prepare("UPDATE streamers SET avatar = NULL WHERE owner_id = ? AND avatar = ?").bind(userId, url),
  ]);
  await env.IMAGES.delete(`avatar/${userId}`);
}

/** `DELETE /api/images/logo`: the page goes back to the owner's profile picture. */
export async function deleteLogo(env: AppEnv, userId: string): Promise<void> {
  const db = drizzle(env.DB);
  const profile = (await db.select().from(streamers).where(eq(streamers.ownerId, userId)).limit(1))[0];
  if (!profile) throw new HttpError(403, "Create a streamer profile first.");
  await assertStreamerWritable(env, profile.id, userId);
  await db.update(streamers).set({ logo: null }).where(eq(streamers.id, profile.id));
  await env.IMAGES.delete(`logo/${userId}`);
}

export async function serveImage(env: AppEnv, path: string, method: string): Promise<Response> {
  if (!/^(avatar|background|logo)\/[a-zA-Z0-9_-]{1,128}$/.test(path)) throw new HttpError(404, "Image not found.");
  // Serve only images a live account or streamer page still references. An object left in R2 after an
  // account deletion (for example, when the storage delete failed) is then never public again.
  const [kind, userId] = path.split("/");
  const url = `/images/${path}`;
  const reference =
    kind === "avatar"
      ? env.DB.prepare("SELECT 1 AS live FROM user WHERE id=? AND image=?").bind(userId, url)
      : env.DB.prepare(`SELECT 1 AS live FROM streamers WHERE owner_id=? AND ${kind}=?`).bind(userId, url);
  if (!(await reference.first<{ live: number }>())) throw new HttpError(404, "Image not found.");
  const object = await env.IMAGES.get(path);
  if (!object) throw new HttpError(404, "Image not found.");
  const headers = new Headers({
    "Cache-Control": "no-cache",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "X-Content-Type-Options": "nosniff",
  });
  headers.set("Content-Type", object.httpMetadata?.contentType ?? "application/octet-stream");
  headers.set("ETag", object.httpEtag);
  return new Response(method === "HEAD" ? null : object.body, { headers });
}
