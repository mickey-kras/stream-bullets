import { assertStreamerWritable } from "../access.server";
import { activityAvailable } from "../channel-tokens.server";
import { consumeMutationQuota, getOwnStreamer } from "../data.server";
import { HttpError, getOrigin, json, readJson } from "../http.server";
import { notifyMash, notifyOverlay, notifyOverlayKey, notifyPlayground } from "../live.server";
import { mashStartSchema, runMashAction, type MashAction } from "../mash.server";
import { callIngest } from "../ingest-call.server";
import { contentSources, onStream } from "../../lib/overlay-layers";
import { playgroundControlSchema, playgroundStatusSchema } from "../../lib/playground/protocol";
import { overlayKeySchema, regenerateOverlayKey } from "../overlay-key.server";
import { getOverlayData, getOverlayState, overlayActionSchema, sourceTopics, updateOverlay } from "../overlay.server";
import { get, requireViewer, write, type ApiRoute } from "./router";

// Mash controls use HTTP; taps use the live WebSocket. Create battles with `POST /api/streamers/:handle
// {action:"create", kind:"mash"}`.
export const liveRoutes: ApiRoute[] = [
  // POST /api/mash/:id/start {countdown?} | /end {} | /restart {} → {ok: true}
  write("POST", /mash\/([0-9a-f-]{36})\/(start|end|restart)/, async ({ request, env, match, viewer }) => {
    const input = await readJson(request, mashStartSchema);
    const { streamerId } = await runMashAction(env, viewer.id, match[1], match[2] as MashAction, input);
    notifyMash(env, streamerId, match[1]);
    return json({ ok: true });
  }),
  // GET /api/overlay → {overlay, data, handle}: the owner's overlay control state.
  get(/overlay/, async ({ env, viewer }) => {
    const owner = requireViewer(viewer);
    const streamer = await getOwnStreamer(env, owner.id);
    if (!streamer) throw new HttpError(404, "You do not have a streamer page.");
    const overlay = await getOverlayState(env, streamer.id);
    const data = await getOverlayData(env, streamer.id, sourceTopics(contentSources(overlay.layers)));
    return json({ overlay, data, handle: streamer.handle });
  }),
  // POST /api/overlay/key {} → {url}: a new overlay key, shown this once. The old key stops working.
  write("POST", /overlay\/key/, async ({ request, env, viewer }) => {
    await readJson(request, overlayKeySchema);
    const streamer = await getOwnStreamer(env, viewer.id);
    if (!streamer) throw new HttpError(404, "You do not have a streamer page.");
    await consumeMutationQuota(env, viewer.id, true);
    const key = await regenerateOverlayKey(env, viewer.id, streamer);
    notifyOverlayKey(env, streamer.id);
    return json({ url: `${getOrigin(env)}/@${streamer.handle}/overlay?key=${key}` });
  }),
  // POST /api/overlay/characters {op: status|test|stopTest|pause|resume|reset|remove, id?} → {paused, testEndsAt}: the
  // character playground. `status` only reads. Starting a test, a reset and a removal use the write quota; the others
  // never do, so the owner can always read, stop or pause.
  write("POST", /overlay\/characters/, async ({ request, env, viewer }) => {
    const control = await readJson(request, playgroundControlSchema);
    const streamer = await getOwnStreamer(env, viewer.id);
    if (!streamer) throw new HttpError(404, "You do not have a streamer page.");
    await assertStreamerWritable(env, streamer.id, viewer.id);
    if (!activityAvailable(env)) throw new HttpError(503, "Characters are off on this server.");
    if (control.op === "test" && !onStream((await getOverlayState(env, streamer.id)).layers, "characters"))
      throw new HttpError(400, "Put the characters layer on stream first.");
    if (control.op === "test" || control.op === "reset" || control.op === "remove")
      await consumeMutationQuota(env, viewer.id);
    const response = await callIngest(env, streamer.id, "playground", {
      init: { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(control) },
    });
    if (response.status === 404) throw new HttpError(404, "That character is not on the playground.");
    if (!response.ok) throw new HttpError(503, "The character playground is not available. Try again.");
    const status = playgroundStatusSchema.safeParse(await response.json().catch((): null => null));
    if (!status.success) throw new Error("playground status invalid");
    return json(status.data);
  }),
  // POST /api/overlay {action: showResults|message|layers|chatTest, ...} → {overlay}
  write("POST", /overlay/, async ({ request, env, viewer }) => {
    const action = await readJson(request, overlayActionSchema);
    const streamer = await getOwnStreamer(env, viewer.id);
    if (!streamer) throw new HttpError(404, "You do not have a streamer page.");
    // Layer edits arrive from grid drags and keys, so they share the write quota with starting a chat test. Stop
    // costs no quota, so the owner can always end a test.
    if (action.action === "layers" || (action.action === "chatTest" && action.on))
      await consumeMutationQuota(env, viewer.id);
    const { overlay, changed } = await updateOverlay(env, viewer.id, streamer.id, action);
    // An ignored old layer write changed nothing, so the overlay pages need no update.
    if (changed) notifyOverlay(env, streamer.id);
    // Only the layers configure the character playground.
    if (changed && action.action === "layers") notifyPlayground(env, streamer.id);
    return json({ overlay });
  }),
];
