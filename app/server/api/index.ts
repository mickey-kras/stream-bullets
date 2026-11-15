import { accountRoutes } from "./account";
import { adminRoutes } from "./admin";
import { aiRoutes } from "./ai";
import { channelRoutes } from "./channels";
import { communityRoutes } from "./community";
import { conversionRoutes } from "./conversions";
import { cookieRoutes } from "./cookies";
import { entryRoutes } from "./entries";
import { imageRoutes } from "./images";
import { liveRoutes } from "./live";
import { moderationRoutes } from "./moderation";
import type { ApiRoute } from "./router";
import { scheduleRoutes } from "./schedule";
import { streamerRoutes } from "./streamers";

// Route `/api/*` except Better Auth and the live and activity upgrades. Match complete paths after `/api/`; order
// matters only for overlapping patterns. Add feature `ApiRoute[]` tables here. Page writes must call
// `assertStreamerWritable()`.
export const apiRoutes: readonly ApiRoute[] = [
  ...accountRoutes,
  ...streamerRoutes,
  ...entryRoutes,
  ...imageRoutes,
  ...moderationRoutes,
  ...scheduleRoutes,
  ...communityRoutes,
  ...liveRoutes,
  ...channelRoutes,
  ...adminRoutes,
  ...aiRoutes,
  ...cookieRoutes,
  ...conversionRoutes,
];

export { dispatch } from "./router";
