import { z } from "zod";
import type { AppEnv } from "../../env";
import type { Streamer } from "../../types";
import { alertControlSchema } from "../../lib/alert-control";
import { isStreamerListed } from "../access.server";
import { controlAlerts } from "../alert-control.server";
import { consumeMutationQuota, getOwnStreamer, getStreamer, mutateEntry } from "../data.server";
import { dockKeyMatches, regenerateDockKey } from "../dock-key.server";
import { HttpError, getOrigin, json, readJson } from "../http.server";
import { notifyDockKey, notifyOverlay, notifyRoom } from "../live.server";
import { overlayActionSchema, updateOverlay, type OverlayAction } from "../overlay.server";
import { openWrite, write, type ApiRoute } from "./router";

// The private OBS dock. The owner makes the dock link with a session. The dock page then has no session: its
// requests carry the dock key in a header. The key grants the live controls of the Live section and nothing else.
// An overlay key is not a dock key, so it never grants a control action.

/** The header of a dock request with the dock key. A header is not in a server log or in the browser history. */
export const DOCK_KEY_HEADER = "X-SB-Dock-Key";

/**
 * The page of a dock request. The answer is the same for a page that does not exist, a page that is suspended, and
 * a key that is wrong: a request without the key learns nothing about the pages.
 */
async function dockPage(env: AppEnv, handle: string, request: Request): Promise<Streamer> {
  const streamer: Streamer | null = await getStreamer(env, handle);
  const allowed: boolean =
    streamer !== null &&
    isStreamerListed(streamer.status) &&
    (await dockKeyMatches(env, streamer.id, request.headers.get(DOCK_KEY_HEADER)));
  if (!streamer || !allowed) throw new HttpError(403, "Use the dock link of this page.", "dock_key");
  return streamer;
}

/** The layers that the dock can change, and their fields. The dock never changes the layout or a setting. */
const DOCK_LAYERS: ReadonlySet<string> = new Set<string>(["poll", "topic", "message"]);
const DOCK_FIELDS: ReadonlySet<string> = new Set<string>(["enabled", "ref", "qr"]);

/** The refusal of a change that the dock key does not allow. */
function dockRefusal(): HttpError {
  return new HttpError(403, "The dock cannot make this change. Use Streamer tools.", "dock_action");
}

/**
 * `action` when the dock may send it: the results switch, the message, and for the poll, the topic, and the message
 * banner the switch "Show on stream", the picked item, and the QR code. Each other change belongs to the owner's
 * session in Streamer tools.
 */
export function dockAction(action: OverlayAction): OverlayAction {
  if (action.action === "showResults" || action.action === "message") return action;
  const refused: HttpError = dockRefusal();
  if (action.action !== "layers") throw refused;
  const { items, ...others } = action;
  // `others` holds the action name and each other field of the patch.
  if (!items || Object.keys(others).length > 1) throw refused;
  for (const [layer, item] of Object.entries(items))
    if (!DOCK_LAYERS.has(layer) || Object.keys(item).some((field: string): boolean => !DOCK_FIELDS.has(field)))
      throw refused;
  return action;
}

export const dockRoutes: ApiRoute[] = [
  // POST /api/dock/key {} → {url}: a new dock link for the page of the signed-in owner. The link shows one time.
  // The old link stops at once.
  write("POST", /dock\/key/, async ({ request, env, viewer }) => {
    await readJson(request, z.object({}).strict());
    const streamer = await getOwnStreamer(env, viewer.id);
    if (!streamer) throw new HttpError(404, "You do not have a streamer page.");
    await consumeMutationQuota(env, viewer.id, true);
    const key: string = await regenerateDockKey(env, viewer.id, streamer);
    notifyDockKey(env, streamer.id);
    return json({ url: `${getOrigin(env)}/@${streamer.handle}/dock?key=${key}` });
  }),
  // POST /api/dock/:handle/overlay {action: showResults|message|layers, ...} → {overlay}: a live control from the
  // dock, with the dock key in the header.
  openWrite("POST", /dock\/([a-z0-9_]{3,30})\/overlay/, async ({ request, env, match }) => {
    const streamer: Streamer = await dockPage(env, match[1], request);
    const action: OverlayAction = dockAction(await readJson(request, overlayActionSchema));
    // The dock acts for the owner: its changes use the write quota of the owner.
    await consumeMutationQuota(env, streamer.ownerId);
    const { overlay, changed } = await updateOverlay(env, streamer.ownerId, streamer.id, action);
    if (changed) notifyOverlay(env, streamer.id);
    return json({ overlay });
  }),
  // POST /api/dock/:handle/alerts {op: status|test|mute|skip|replay, kind?, on?, id?} → {at, muted, current,
  // waiting, goal}: a control of the alerts from the dock, with the dock key in the header. The dock acts for the
  // owner: a test and a replay use the write quota of the owner. A new count of the goal belongs to the session of
  // the owner.
  openWrite("POST", /dock\/([a-z0-9_]{3,30})\/alerts/, async ({ request, env, match }) => {
    const streamer: Streamer = await dockPage(env, match[1], request);
    const control = await readJson(request, alertControlSchema);
    if (control.op === "goalReset") throw dockRefusal();
    return json(await controlAlerts(env, streamer.id, streamer.ownerId, control));
  }),
  // POST /api/dock/:handle/poll {id} → {id}: closes the voting of a poll of the page.
  openWrite("POST", /dock\/([a-z0-9_]{3,30})\/poll/, async ({ request, env, match }) => {
    const streamer: Streamer = await dockPage(env, match[1], request);
    const { id } = await readJson(request, z.object({ id: z.string().uuid() }).strict());
    const result = await mutateEntry(env, streamer.ownerId, streamer.id, { action: "reveal", id });
    notifyRoom(env, streamer.id);
    return json(result);
  }),
];
