import { z } from "zod";
import type { AppEnv } from "../../env";
import { requestLocale } from "../../i18n/resolve";
import { getOwnStreamer, getVisibleStreamer } from "../data.server";
import { HttpError, json, readJson } from "../http.server";
import { refreshOverlayFor } from "../overlay.server";
import { attachPageTranslations, translatePageAfterSave } from "../page-translation.server";
import { createEvents, deleteEvent, listEvents, patchEvent } from "../schedule.server";
import { eventRangeSchema } from "../validation";
import { get, parsedQuery, write, type ApiRoute } from "./router";

const eventPath = /events\/([a-f0-9-]{36})/;

function eventId(match: RegExpExecArray): string {
  if (!z.string().uuid().safeParse(match[1]).success) throw new HttpError(404, "Stream not found.");
  return match[1];
}

// A new or changed stream gets its translations after the response. A removal deletes the stored results.
async function scheduleChanged(env: AppEnv, ownerId: string): Promise<void> {
  await refreshOverlayFor(env, ownerId, ["next"]);
  const page = await getOwnStreamer(env, ownerId);
  if (page) translatePageAfterSave(env, page.id);
}

// Schedule reads are public; only the owner writes.
export const scheduleRoutes: ApiRoute[] = [
  // GET /api/streamers/:handle/events?from&to → {events, serverNow}
  get(/streamers\/([a-z0-9_]{3,30})\/events/, async ({ request, env, match, viewer }) => {
    const range = parsedQuery(request, ["from", "to"], eventRangeSchema);
    const streamer = await getVisibleStreamer(env, match[1], viewer?.id ?? null);
    if (!streamer) throw new HttpError(404, "Streamer not found.");
    const now = Date.now();
    const events = await listEvents(env, streamer.id, range.from, range.to, now);
    await attachPageTranslations(env, streamer, requestLocale(request, viewer?.locale ?? null), [], events);
    return json({ events, serverNow: now });
  }),
  // Schedule writes refresh overlays showing Up next.
  write("POST", /events/, async ({ request, env, viewer }) => {
    const event = await createEvents(env, viewer.id, await readJson(request, z.unknown()));
    await scheduleChanged(env, viewer.id);
    return json({ event });
  }),
  // PATCH /api/events/:id {action: "edit", scope, ...} | {action: "cancel"} | {action: "replay", vodUrl} →
  // {event}
  write("PATCH", eventPath, async ({ request, env, match, viewer }) => {
    const event = await patchEvent(env, viewer.id, eventId(match), await readJson(request, z.unknown()));
    await scheduleChanged(env, viewer.id);
    return json({ event });
  }),
  // DELETE /api/events/:id, optional body {scope: "one" | "following"} → {deleted: true}
  write("DELETE", eventPath, async ({ request, env, match, viewer }) => {
    const body = request.headers.get("Content-Type") ? await readJson(request, z.unknown()) : {};
    await deleteEvent(env, viewer.id, eventId(match), body);
    await scheduleChanged(env, viewer.id);
    return json({ deleted: true });
  }),
];
