import { asc, ne } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { streamers } from "../../db/schema";
import type { AppEnv } from "../env";
import { PUBLIC_PAGE_PATHS } from "../lib/seo";
import { getOrigin, HttpError } from "./http.server";

/** Public directory visibility also applies to crawler discovery. */
export async function sitemapResponse(request: Request, env: AppEnv): Promise<Response> {
  if (!["GET", "HEAD"].includes(request.method)) throw new HttpError(405, "Method not allowed.");
  const origin: string = getOrigin(env);
  const rows = await drizzle(env.DB)
    .select({ handle: streamers.handle })
    .from(streamers)
    .where(ne(streamers.status, "suspended"))
    .orderBy(asc(streamers.handle));
  const paths: string[] = [...PUBLIC_PAGE_PATHS, ...rows.map((row): string => `/@${row.handle}`)];
  const urls: string = paths
    .map((path: string): string => `<url><loc>${escapeXml(`${origin}${path}`)}</loc></url>`)
    .join("");
  return new Response(
    request.method === "HEAD"
      ? null
      : `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`,
    {
      headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=300" },
    },
  );
}

function escapeXml(value: string): string {
  const entities: Readonly<Record<string, string>> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&apos;",
  };
  return value.replace(/[&<>"']/gu, (character: string): string => entities[character]);
}
