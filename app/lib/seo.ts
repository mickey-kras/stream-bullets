import type { MetaDescriptor } from "react-router";
import { shellFromMatches } from "./shell";

export const PUBLIC_PAGE_PATHS: readonly string[] = ["/", "/streamers", "/privacy", "/terms", "/ai"];

/** Use the configured origin and a resolved page identity, never the request's UI parameters. */
export function canonicalMeta(matches: Parameters<typeof shellFromMatches>[0], path: string): MetaDescriptor[] {
  const origin: string | undefined = shellFromMatches(matches)?.origin;
  return origin ? [{ tagName: "link", rel: "canonical", href: `${origin}${path}` }] : [];
}

export function streamerCanonicalPath(
  handle: string,
  view: string,
  entryId: string | null,
  eventId: string | null,
): string {
  const params = new URLSearchParams();
  if (entryId) params.set("entry", entryId);
  else if (eventId) {
    params.set("view", "schedule");
    params.set("event", eventId);
  } else if (view !== "topics") params.set("view", view);
  const query: string = params.toString();
  return `/@${handle}${query ? `?${query}` : ""}`;
}
