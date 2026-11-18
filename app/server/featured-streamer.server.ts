import type { AppEnv } from "../env";

export interface FeaturedStreamer {
  handle: string;
  name: string;
  isOfficial: boolean;
}

// The official page. The directory shows it as the ideas strip, not as a streamer.
export async function getFeaturedStreamer(env: AppEnv): Promise<FeaturedStreamer | null> {
  const streamer = await env.DB.prepare(`
    SELECT handle, name, is_official FROM streamers
    WHERE status = 'active' AND is_official = 1 ORDER BY handle ASC LIMIT 1
  `).first<{ handle: string; name: string; is_official: number }>();
  if (!streamer) return null;
  return { handle: streamer.handle, name: streamer.name, isOfficial: Boolean(streamer.is_official) };
}
