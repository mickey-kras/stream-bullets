import { accountRoutes } from "./account";
import { adminRoutes } from "./admin";
import { entryRoutes } from "./entries";
import { imageRoutes } from "./images";
import { moderationRoutes } from "./moderation";
import type { ApiRoute } from "./router";
import { streamerRoutes } from "./streamers";

/**
 * Every `/api/*` endpoint except `/api/auth/*` (Better Auth) and `/api/live/:handle` (the worker's
 * WebSocket upgrade). Paths are matched whole against the part after `/api/`, so their order only
 * matters for paths that two patterns can both match.
 *
 * To add a feature (schedule, cards, links, overlay, Mash, admin, step-up, ai-interest): write
 * `app/server/api/<feature>.ts` exporting an `ApiRoute[]` built with `get()` and `write()`, and add
 * it to this list. Writes to a streamer page must call `assertStreamerWritable()` first.
 */
export const apiRoutes: readonly ApiRoute[] = [
  ...accountRoutes,
  ...streamerRoutes,
  ...entryRoutes,
  ...imageRoutes,
  ...moderationRoutes,
  ...adminRoutes,
];

export { dispatch } from "./router";
