import type { AppEnv } from "../env";
import type { EntryKind } from "../types";

export interface FeaturedEntry {
  id: string;
  title: string;
  kind: EntryKind;
}

export interface FeaturedStreamer {
  handle: string;
  name: string;
  isOfficial: boolean;
  entries: FeaturedEntry[];
}

// Prefer a public page with content, using the directory's order to break ties.
export async function getFeaturedStreamer(env: AppEnv): Promise<FeaturedStreamer | null> {
  const streamer = await env.DB.prepare(`
    SELECT id, handle, name, is_official FROM streamers s WHERE status = 'active'
    ORDER BY EXISTS(SELECT 1 FROM entries e WHERE e.streamer_id = s.id) DESC,
      is_official DESC, handle ASC LIMIT 1
  `).first<{ id: string; handle: string; name: string; is_official: number }>();
  if (!streamer) return null;
  const entries = await env.DB.prepare(`
    SELECT id, title, kind FROM entries WHERE streamer_id = ?
    ORDER BY created_at DESC, id DESC LIMIT 3
  `)
    .bind(streamer.id)
    .all<FeaturedEntry>();
  return {
    handle: streamer.handle,
    name: streamer.name,
    isOfficial: Boolean(streamer.is_official),
    entries: entries.results,
  };
}
