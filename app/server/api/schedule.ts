import { z } from "zod";
import { getVisibleStreamer } from "../data.server";
import { HttpError, json, readJson } from "../http.server";
import { refreshOverlayFor } from "../overlay.server";
import { createEvents, deleteEvent, listEvents, patchEvent } from "../schedule.server";
import { eventRangeSchema } from "../validation";
import { get, parsedQuery, write, type ApiRoute } from "./router";

const eventPath = /events\/([a-f0-9-]{36})/;

function eventId(match: RegExpExecArray): string {
  if (!z.string().uuid().safeParse(match[1]).success) throw new HttpError(404, "Stream not found.");
  return match[1];
}

/** The stream schedule (item 23). Reads are public; writes are the page owner's. */
export const scheduleRoutes: ApiRoute[] = [
  // GET /api/streamers/:handle/events?from&to → {events, serverNow}
  get(/streamers\/([a-z0-9_]{3,30})\/events/, async ({ request, env, match, viewer }) => {
    const range = parsedQuery(request, ["from", "to"], eventRangeSchema);
    const streamer = await getVisibleStreamer(env, match[1], viewer?.id ?? null);
    if (!streamer) throw new HttpError(404, "Streamer not found.");
    const now = Date.now();
    return json({ events: await listEvents(env, streamer.id, range.from, range.to, now), serverNow: now });
  }),
  // Every write below may change the next stream, so an overlay showing Up next reloads after it.
  // POST /api/events {title, notes, date, time, tz, durationMin, platform, url, repeatDays, repeatUntil, topicIds} → {event}
  write("POST", /events/, async ({ request, env, viewer }) => {
    const event = await createEvents(env, viewer.id, await readJson(request, z.unknown()));
    await refreshOverlayFor(env, viewer.id, ["next"]);
    return json({ event });
  }),
  // PATCH /api/events/:id {action: "edit", scope, ...} | {action: "cancel"} | {action: "replay", vodUrl} → {event}
  write("PATCH", eventPath, async ({ request, env, match, viewer }) => {
    const event = await patchEvent(env, viewer.id, eventId(match), await readJson(request, z.unknown()));
    await refreshOverlayFor(env, viewer.id, ["next"]);
    return json({ event });
  }),
  // DELETE /api/events/:id, optional body {scope: "one" | "following"} → {deleted: true}
  write("DELETE", eventPath, async ({ request, env, match, viewer }) => {
    const body = request.headers.get("Content-Type") ? await readJson(request, z.unknown()) : {};
    await deleteEvent(env, viewer.id, eventId(match), body);
    await refreshOverlayFor(env, viewer.id, ["next"]);
    return json({ deleted: true });
  }),
];
