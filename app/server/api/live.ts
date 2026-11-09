import { consumeMutationQuota, getOwnStreamer } from "../data.server";
import { HttpError, getOrigin, json, readJson } from "../http.server";
import { notifyMash, notifyOverlay, notifyOverlayKey } from "../live.server";
import { mashStartSchema, runMashAction, type MashAction } from "../mash.server";
import { overlayKeySchema, regenerateOverlayKey } from "../overlay-key.server";
import { getOverlayData, getOverlayState, overlayActionSchema, sourceTopics, updateOverlay } from "../overlay.server";
import { get, requireViewer, write, type ApiRoute } from "./router";

/**
 * Mash Battle owner controls and overlay control (Phase 5). Taps do not come here: they go over the
 * live WebSocket (R16). Creating a battle is `POST /api/streamers/:handle {action:"create", kind:"mash"}`.
 */
export const liveRoutes: ApiRoute[] = [
  // POST /api/mash/:id/start {countdown?} | /end {} | /restart {} → {ok: true}
  write("POST", /mash\/([0-9a-f-]{36})\/(start|end|restart)/, async ({ request, env, match, viewer }) => {
    const input = await readJson(request, mashStartSchema);
    const { streamerId } = await runMashAction(env, viewer.id, match[1], match[2] as MashAction, input);
    await notifyMash(env, streamerId, match[1]);
    return json({ ok: true });
  }),
  // GET /api/overlay → {overlay, data, handle}: the owner's overlay control state.
  get(/overlay/, async ({ env, viewer }) => {
    const owner = requireViewer(viewer);
    const streamer = await getOwnStreamer(env, owner.id);
    if (!streamer) throw new HttpError(404, "You do not have a streamer page.");
    const overlay = await getOverlayState(env, streamer.id);
    const data = await getOverlayData(env, streamer.id, sourceTopics(overlay.air, overlay.preview));
    return json({ overlay, data, handle: streamer.handle });
  }),
  // POST /api/overlay/key {} → {url}: a new overlay key, shown this once. The old key stops working.
  write("POST", /overlay\/key/, async ({ request, env, viewer }) => {
    await readJson(request, overlayKeySchema);
    const streamer = await getOwnStreamer(env, viewer.id);
    if (!streamer) throw new HttpError(404, "You do not have a streamer page.");
    await consumeMutationQuota(env, viewer.id, true);
    const key = await regenerateOverlayKey(env, viewer.id, streamer);
    await notifyOverlayKey(env, streamer.id);
    return json({ url: `${getOrigin(env)}/@${streamer.handle}/overlay?key=${key}` });
  }),
  // POST /api/overlay {action: preview|take|layout|message, ...} → {overlay}
  write("POST", /overlay/, async ({ request, env, viewer }) => {
    const action = await readJson(request, overlayActionSchema);
    const streamer = await getOwnStreamer(env, viewer.id);
    if (!streamer) throw new HttpError(404, "You do not have a streamer page.");
    const overlay = await updateOverlay(env, viewer.id, streamer.id, action);
    await notifyOverlay(env, streamer.id);
    return json({ overlay });
  }),
];
