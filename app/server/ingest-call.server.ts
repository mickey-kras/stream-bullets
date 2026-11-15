import type { AppEnv } from "../env";
import type { ActivityPlatform } from "../lib/activity";

/** The requests the Worker and the API send to a page's ChannelIngest object (app/server/channel-ingest.ts). */
export type IngestPath =
  | "subscribe"
  | "event"
  | "connect"
  | "disconnect"
  | "status"
  | "overlay-key"
  | "page-status"
  | "close"
  | "refresh";

/** Calls the page's ingest object. `init` defaults to an empty POST. */
export function callIngest(
  env: AppEnv,
  streamerId: string,
  path: IngestPath,
  options: { platform?: ActivityPlatform; init?: RequestInit } = {},
): Promise<Response> {
  const query = new URLSearchParams({ streamerId, ...(options.platform ? { platform: options.platform } : {}) });
  const stub = env.CHANNEL_INGEST.get(env.CHANNEL_INGEST.idFromName(streamerId));
  return stub.fetch(`https://channel-ingest.internal/${path}?${query}`, options.init ?? { method: "POST" });
}
