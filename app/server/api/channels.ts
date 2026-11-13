import { z } from "zod";
import type { AppEnv } from "../../env";
import type { Streamer } from "../../types";
import { assertStreamerWritable } from "../access.server";
import { requireRecentSignIn } from "../auth.server";
import { disconnect, listConnections, platformSchema, startConnect } from "../channels.server";
import { consumeMutationQuota, getOwnStreamer } from "../data.server";
import { HttpError, json, queryParams, readJson } from "../http.server";
import { get, requireViewer, write, type ApiRoute } from "./router";

/** Connecting and disconnecting a channel take no options. */
const emptySchema = z.object({}).strict();

const RECENT_SIGN_IN = "Sign in again to change channel connections.";

async function ownStreamer(env: AppEnv, userId: string): Promise<Streamer> {
  const streamer = await getOwnStreamer(env, userId);
  if (!streamer) throw new HttpError(404, "You do not have a streamer page.");
  return streamer;
}

function platformOf(match: RegExpExecArray): z.infer<typeof platformSchema> {
  return platformSchema.parse(match[1]);
}

/**
 * Channel connections for the owner's page (docs/channel-connections.md). Changes need a recent sign-in and
 * count against the content quota. Responses never include tokens or scopes.
 */
export const channelRoutes: ApiRoute[] = [
  // GET /api/channels → {channels}
  get(/channels/, async ({ request, env, viewer }) => {
    queryParams(request, []);
    const owner = requireViewer(viewer);
    const streamer = await ownStreamer(env, owner.id);
    return json({ channels: await listConnections(env, streamer.id) });
  }),
  // POST /api/channels/:platform/connect | /reconnect {} → {authorizeUrl}
  write("POST", /channels\/(twitch|youtube|kick)\/(?:connect|reconnect)/, async ({ request, env, match, viewer }) => {
    await readJson(request, emptySchema);
    const streamer = await ownStreamer(env, viewer.id);
    await assertStreamerWritable(env, streamer.id, viewer.id);
    await requireRecentSignIn(request, env, Date.now(), RECENT_SIGN_IN);
    await consumeMutationQuota(env, viewer.id, true);
    return json({ authorizeUrl: await startConnect(env, viewer.id, streamer.id, platformOf(match)) });
  }),
  // DELETE /api/channels/:platform → {revoked}. A frozen page may still disconnect: it only removes access.
  write("DELETE", /channels\/(twitch|youtube|kick)/, async ({ request, env, match, viewer }) => {
    // Like DELETE /api/events/:id: no body, or an empty JSON object.
    if (request.headers.get("Content-Type")) await readJson(request, emptySchema);
    const streamer = await ownStreamer(env, viewer.id);
    await requireRecentSignIn(request, env, Date.now(), RECENT_SIGN_IN);
    await consumeMutationQuota(env, viewer.id, true);
    return json(await disconnect(env, viewer.id, streamer.id, platformOf(match)));
  }),
];
