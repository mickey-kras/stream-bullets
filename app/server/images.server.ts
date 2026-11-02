import { imageSize } from 'image-size';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { streamers } from '../../db/schema';
import type { AppEnv } from '../env';
import { HttpError, readBody } from './http.server';

const types: Readonly<Record<string, string>> = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export function validateImage(bytes: Uint8Array, contentType: string | null): string {
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new HttpError(413, 'Choose an image up to 5 MB.');
  let dimensions: ReturnType<typeof imageSize>;
  try { dimensions = imageSize(bytes); } catch { throw new HttpError(400, 'Choose a valid PNG, JPEG, or WebP image.'); }
  const mime = dimensions.type ? types[dimensions.type] : undefined;
  if (!mime || mime !== contentType) throw new HttpError(415, 'Choose a PNG, JPEG, or WebP image.');
  if (!dimensions.width || !dimensions.height || dimensions.width > 8192 || dimensions.height > 8192 || dimensions.width * dimensions.height > 16_000_000) {
    throw new HttpError(400, 'Choose an image up to 16 million pixels and 8192 pixels per side.');
  }
  return mime;
}

export async function uploadImage(request: Request, env: AppEnv, userId: string, kind: string): Promise<string> {
  if (kind !== 'avatar' && kind !== 'background') throw new HttpError(404, 'Image type not found.');
  const db = drizzle(env.DB);
  const profile = (await db.select().from(streamers).where(eq(streamers.ownerId, userId)).limit(1))[0];
  if (kind === 'background' && !profile) throw new HttpError(403, 'Create a streamer profile first.');
  const bytes = await readBody(request, MAX_IMAGE_BYTES);
  const contentType = validateImage(bytes, request.headers.get('Content-Type'));
  const key = `${kind}/${userId}`;
  const url = `/images/${key}`;
  await env.IMAGES.put(key, bytes, { httpMetadata: { contentType, cacheControl: 'no-cache' } });
  if (kind === 'avatar') {
    await env.DB.batch([
      env.DB.prepare('UPDATE user SET image = ?, updated_at = ? WHERE id = ?').bind(url, Date.now(), userId),
      env.DB.prepare('UPDATE streamers SET avatar = ? WHERE owner_id = ?').bind(url, userId),
    ]);
  } else {
    await db.update(streamers).set({ background: url }).where(eq(streamers.ownerId, userId));
  }
  return url;
}

export async function serveImage(env: AppEnv, path: string, method: string): Promise<Response> {
  if (!/^(avatar|background)\/[a-zA-Z0-9_-]{1,128}$/.test(path)) throw new HttpError(404, 'Image not found.');
  const object = await env.IMAGES.get(path);
  if (!object) throw new HttpError(404, 'Image not found.');
  const headers = new Headers({ 'Cache-Control': 'no-cache', 'Content-Security-Policy': "default-src 'none'; sandbox", 'X-Content-Type-Options': 'nosniff' });
  headers.set('Content-Type', object.httpMetadata?.contentType ?? 'application/octet-stream');
  headers.set('ETag', object.httpEtag);
  return new Response(method === 'HEAD' ? null : object.body, { headers });
}
