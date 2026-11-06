import { notifyRoom } from "../live.server";
import {
  getOwnStreamer,
  getStreamer,
  getVisibleStreamer,
  listEntries,
  listStreamers,
  mutateEntry,
  saveStreamer,
  updateStreamer,
} from "../data.server";
import { HttpError, json, readJson } from "../http.server";
import {
  directoryQuerySchema,
  entryActionSchema,
  entryQuerySchema,
  streamerEditSchema,
  streamerSchema,
} from "../validation";
import { get, parsedQuery, write, type ApiRoute } from "./router";

/** The directory, a page's board, page edits, and the topic and poll actions on a page. */
export const streamerRoutes: ApiRoute[] = [
  // GET /api/streamers?cursor&query → {streamers, nextCursor}. Official pages first; suspended pages left out.
  get(/streamers/, async ({ request, env }) => {
    const input = parsedQuery(request, ["cursor", "query"], directoryQuerySchema);
    return json(await listStreamers(env, input.cursor, input.query));
  }),
  get(/streamers\/([a-z0-9_]{3,30})/, async ({ request, env, match, viewer }) => {
    const input = parsedQuery(request, ["kind", "sort", "query", "cursor"], entryQuerySchema);
    const streamer = await getVisibleStreamer(env, match[1], viewer?.id ?? null);
    if (!streamer) throw new HttpError(404, "Streamer not found.");
    return json(await listEntries(env, streamer, viewer?.id ?? null, input));
  }),
  write("POST", /streamers\/([a-z0-9_]{3,30})/, async ({ request, env, match, viewer }) => {
    const input = await readJson(request, entryActionSchema);
    const streamer = await getStreamer(env, match[1]);
    if (!streamer) throw new HttpError(404, "Streamer not found.");
    // mutateEntry checks the page status (assertStreamerWritable).
    const result = await mutateEntry(env, viewer.id, streamer.id, input);
    await notifyRoom(env, streamer.id);
    return json(result);
  }),
  // PATCH /api/streamer {name?, about?, handle?, logoMode?: "profile" | "logo"} → {streamer}
  write("PATCH", /streamer/, async ({ request, env, viewer }) =>
    json({ streamer: await updateStreamer(env, viewer.id, await readJson(request, streamerEditSchema)) }),
  ),
  // POST /api/streamer {handle, name, about} → {streamer}: claims the handle and creates the page (approved
  // accounts and admins). Later edits go through PATCH /api/streamer.
  write("POST", /streamer/, async ({ request, env, viewer }) => {
    const input = await readJson(request, streamerSchema);
    if (await getOwnStreamer(env, viewer.id)) throw new HttpError(409, "You already have a streamer page.");
    return json({ streamer: await saveStreamer(env, viewer.id, input) });
  }),
];
