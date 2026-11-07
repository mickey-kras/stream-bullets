import type { z } from "zod";
import type { AppEnv } from "../env";
import { effectiveStatus, expandSeries, SERIES_HORIZON_MS } from "../lib/schedule";
import { addDays, localDateOf, parseDate, weekdayOf, zonedParts, zonedTime, type LocalDate } from "../lib/zoned";
import type { EventTopic, StreamEvent, StreamEventStatus, StreamPlatform } from "../types";
import { assertStreamerWritable } from "./access.server";
import { consumeMutationQuota } from "./data.server";
import { HttpError } from "./http.server";
import { buildCalendar, type IcsEvent } from "./ics";
import { eventDeleteSchema, eventInputSchema, eventPatchSchema, type EventInput, type EventPatch } from "./validation";

/** Upcoming streams a page may hold at once (a few series plus one-offs). */
export const MAX_UPCOMING_EVENTS = 400;
/** Streams that ended this long ago are deleted by the hourly cron. */
export const EVENT_RETENTION_MS = 400 * 86_400_000;

interface EventRow {
  id: string;
  streamer_id: string;
  series_id: string | null;
  title: string;
  notes: string;
  starts_at: number;
  duration_min: number;
  platform: StreamPlatform;
  url: string;
  status: StreamEventStatus;
  vod_url: string | null;
  repeat_days: number;
  repeat_until: number | null;
  tz: string;
  is_exception: number;
  created_at: number;
  updated_at: number;
}

interface OwnedEventRow extends EventRow {
  owner_id: string;
}

function parsed<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new HttpError(400, result.error.issues[0]?.message ?? "Invalid input.");
  return result.data;
}

async function topicsFor(env: AppEnv, ids: string[]): Promise<Map<string, EventTopic[]>> {
  const map = new Map<string, EventTopic[]>(ids.map((id: string): [string, EventTopic[]] => [id, []]));
  if (ids.length === 0) return map;
  const { results } = await env.DB.prepare(`SELECT t.event_id, e.id, e.title, e.category
    FROM stream_event_topics t JOIN entries e ON e.id=t.entry_id
    WHERE t.event_id IN (SELECT value FROM json_each(?)) ORDER BY e.created_at`)
    .bind(JSON.stringify(ids))
    .all<{ event_id: string; id: string; title: string; category: string }>();
  for (const row of results) map.get(row.event_id)?.push({ id: row.id, title: row.title, category: row.category });
  return map;
}

function eventValue(row: EventRow, topics: EventTopic[], now: number): StreamEvent {
  return {
    id: row.id,
    seriesId: row.series_id,
    title: row.title,
    notes: row.notes,
    startsAt: row.starts_at,
    durationMin: row.duration_min,
    platform: row.platform,
    url: row.url,
    status: effectiveStatus(row.status, row.starts_at, row.duration_min, now),
    vodUrl: row.vod_url,
    repeatDays: row.repeat_days,
    repeatUntil: row.repeat_until,
    tz: row.tz,
    topics,
    updatedAt: row.updated_at,
  };
}

/** Streams that overlap `[from, to)`, oldest first, at most 500. */
export async function listEvents(
  env: AppEnv,
  streamerId: string,
  from: number,
  to: number,
  now: number = Date.now(),
): Promise<StreamEvent[]> {
  const { results } = await env.DB.prepare(`SELECT * FROM stream_events
    WHERE streamer_id=? AND starts_at < ? AND starts_at + duration_min * 60000 > ?
    ORDER BY starts_at, id LIMIT 500`)
    .bind(streamerId, to, from)
    .all<EventRow>();
  const topics = await topicsFor(
    env,
    results.map((row: EventRow): string => row.id),
  );
  return results.map((row: EventRow): StreamEvent => eventValue(row, topics.get(row.id) ?? [], now));
}

/** Topics the owner can link to a stream: the 30 newest. */
export async function listTopicChoices(env: AppEnv, streamerId: string): Promise<EventTopic[]> {
  const { results } = await env.DB.prepare(
    "SELECT id, title, category FROM entries WHERE streamer_id=? AND kind='topic' ORDER BY created_at DESC, id DESC LIMIT 30",
  )
    .bind(streamerId)
    .all<EventTopic>();
  return results;
}

/** The range the streamer page loads first: 90 days back (past streams) and the 12 weeks a series covers. */
export function defaultRange(now: number): { from: number; to: number } {
  return { from: now - 90 * 86_400_000, to: now + SERIES_HORIZON_MS + 7 * 86_400_000 };
}

async function ownStreamerId(env: AppEnv, viewerId: string): Promise<string> {
  const row = await env.DB.prepare("SELECT id FROM streamers WHERE owner_id=?").bind(viewerId).first<{ id: string }>();
  if (!row) throw new HttpError(403, "Only streamers can schedule streams.");
  return row.id;
}

async function ownedEvent(env: AppEnv, viewerId: string, id: string): Promise<OwnedEventRow> {
  const row = await env.DB.prepare(
    "SELECT x.*, s.owner_id FROM stream_events x JOIN streamers s ON s.id=x.streamer_id WHERE x.id=?",
  )
    .bind(id)
    .first<OwnedEventRow>();
  if (!row || row.owner_id !== viewerId) throw new HttpError(404, "Stream not found.");
  return row;
}

/** Keeps only topics of this page. */
async function validTopics(env: AppEnv, streamerId: string, ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const { results } = await env.DB.prepare(
    "SELECT id FROM entries WHERE streamer_id=? AND kind='topic' AND id IN (SELECT value FROM json_each(?))",
  )
    .bind(streamerId, JSON.stringify([...new Set(ids)]))
    .all<{ id: string }>();
  return results.map((row: { id: string }): string => row.id);
}

interface Plan {
  starts: number[];
  seriesId: string | null;
  repeatDays: number;
  repeatUntil: number | null;
}

/**
 * Turns the form into start times. A weekly series always includes the first date's weekday and is written
 * 12 weeks ahead (or to its end date); the cron writes the rest as time passes.
 */
export function planEvents(input: EventInput, now: number, seriesId: string | null = null): Plan {
  const first = parseDate(input.date);
  if (!first) throw new HttpError(400, "Pick a valid date.");
  const [hour, minute] = input.time.split(":").map(Number);
  const start = zonedTime(first, hour, minute, input.tz);
  if (input.repeatDays === 0) return { starts: [start], seriesId: null, repeatDays: 0, repeatUntil: null };
  const days = input.repeatDays | (1 << weekdayOf(first));
  const until: LocalDate | null = input.repeatUntil ? parseDate(input.repeatUntil) : null;
  if (
    until &&
    until.year * 10_000 + until.month * 100 + until.day < first.year * 10_000 + first.month * 100 + first.day
  )
    throw new HttpError(400, "The end date is before the first stream.");
  const repeatUntil = until ? zonedTime(addDays(until, 1), 0, 0, input.tz) - 1 : null;
  const starts = expandSeries(
    { first, hour, minute, zone: input.tz, days, until },
    Math.max(now + SERIES_HORIZON_MS, start + 1),
  );
  if (starts.length === 0) throw new HttpError(400, "No stream falls on the chosen days before the end date.");
  return { starts, seriesId: seriesId ?? crypto.randomUUID(), repeatDays: days, repeatUntil };
}

interface Template {
  title: string;
  notes: string;
  durationMin: number;
  platform: StreamPlatform;
  url: string;
  tz: string;
  vodUrl?: string | null;
}

/**
 * Inserts the plan's streams and, for a series, records how far it is written (`stream_series`). `replace` is for
 * a series rewritten from one of its streams onwards; otherwise the mark only moves forward.
 */
function insertStatements(
  env: AppEnv,
  streamerId: string,
  template: Template,
  plan: Plan,
  topicIds: string[],
  now: number,
  through: "extend" | "replace" = "extend",
): { statements: D1PreparedStatement[]; ids: string[] } {
  const statements: D1PreparedStatement[] = [];
  const ids: string[] = [];
  for (const start of plan.starts) {
    const id = crypto.randomUUID();
    ids.push(id);
    statements.push(
      env.DB.prepare(`INSERT INTO stream_events
        (id,streamer_id,series_id,title,notes,starts_at,duration_min,platform,url,status,vod_url,repeat_days,repeat_until,tz,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,'scheduled',?,?,?,?,?,?)`).bind(
        id,
        streamerId,
        plan.seriesId,
        template.title,
        template.notes,
        start,
        template.durationMin,
        template.platform,
        template.url,
        template.vodUrl ?? null,
        plan.repeatDays,
        plan.repeatUntil,
        template.tz,
        now,
        now,
      ),
    );
    if (topicIds.length > 0)
      statements.push(
        env.DB.prepare(
          "INSERT OR IGNORE INTO stream_event_topics (event_id,entry_id) SELECT ?, value FROM json_each(?)",
        ).bind(id, JSON.stringify(topicIds)),
      );
  }
  if (plan.seriesId !== null && plan.starts.length > 0)
    statements.push(
      env.DB.prepare(`INSERT INTO stream_series (id,streamer_id,written_through) VALUES (?,?,?)
        ON CONFLICT(id) DO UPDATE SET written_through=${
          through === "replace" ? "excluded.written_through" : "max(written_through, excluded.written_through)"
        }`).bind(plan.seriesId, streamerId, Math.max(...plan.starts)),
    );
  return { statements, ids };
}

/**
 * Ends a series on the day before `row`: the occurrences that stay get that end date (like one picked in the form),
 * so the cron never writes the deleted or replaced ones again.
 */
function endSeriesBefore(env: AppEnv, seriesId: string, row: { starts_at: number; tz: string }): D1PreparedStatement {
  const until = zonedTime(localDateOf(row.starts_at, row.tz), 0, 0, row.tz) - 1;
  return env.DB.prepare(`UPDATE stream_events SET repeat_until=?
    WHERE series_id=? AND starts_at < ? AND (repeat_until IS NULL OR repeat_until > ?)`).bind(
    until,
    seriesId,
    row.starts_at,
    until,
  );
}

async function assertRoom(env: AppEnv, streamerId: string, adding: number, now: number, freed = 0): Promise<void> {
  const row = await env.DB.prepare("SELECT count(*) AS n FROM stream_events WHERE streamer_id=? AND starts_at >= ?")
    .bind(streamerId, now)
    .first<{ n: number }>();
  if ((row?.n ?? 0) - freed + adding > MAX_UPCOMING_EVENTS)
    throw new HttpError(409, `A schedule can hold up to ${MAX_UPCOMING_EVENTS} upcoming streams.`);
}

function templateOf(input: EventInput): Template {
  return {
    title: input.title,
    notes: input.notes,
    durationMin: input.durationMin,
    platform: input.platform,
    url: input.url,
    tz: input.tz,
  };
}

/** `POST /api/events`: one stream, or a weekly series written 12 weeks ahead. Returns the first one. */
export async function createEvents(env: AppEnv, viewerId: string, value: unknown): Promise<StreamEvent> {
  const input = parsed(eventInputSchema, value);
  const streamerId = await ownStreamerId(env, viewerId);
  await assertStreamerWritable(env, streamerId, viewerId);
  await consumeMutationQuota(env, viewerId, true);
  const now = Date.now();
  const plan = planEvents(input, now);
  await assertRoom(env, streamerId, plan.starts.length, now);
  const topics = await validTopics(env, streamerId, input.topicIds);
  const { statements, ids } = insertStatements(env, streamerId, templateOf(input), plan, topics, now);
  await env.DB.batch(statements);
  const created = await getEvent(env, ids[0], now);
  if (!created) throw new Error("The stream was not saved.");
  return created;
}

export async function getEvent(env: AppEnv, id: string, now: number = Date.now()): Promise<StreamEvent | null> {
  const row = await env.DB.prepare("SELECT * FROM stream_events WHERE id=?").bind(id).first<EventRow>();
  if (!row) return null;
  return eventValue(row, (await topicsFor(env, [id])).get(id) ?? [], now);
}

/** `PATCH /api/events/:id`: edit (this stream, or this and the following ones of a series), cancel, replay link. */
export async function patchEvent(env: AppEnv, viewerId: string, id: string, value: unknown): Promise<StreamEvent> {
  const patch: EventPatch = parsed(eventPatchSchema, value);
  const row = await ownedEvent(env, viewerId, id);
  await assertStreamerWritable(env, row.streamer_id, viewerId);
  await consumeMutationQuota(env, viewerId);
  const now = Date.now();
  const status = effectiveStatus(row.status, row.starts_at, row.duration_min, now);
  if (patch.action === "cancel") {
    if (status === "ended") throw new HttpError(409, "This stream has already ended.");
    await env.DB.prepare("UPDATE stream_events SET status='cancelled', updated_at=? WHERE id=?").bind(now, id).run();
    return (await getEvent(env, id, now))!;
  }
  if (patch.action === "replay") {
    if (status !== "ended") throw new HttpError(409, "Add a replay link after the stream ends.");
    await env.DB.prepare("UPDATE stream_events SET vod_url=?, updated_at=? WHERE id=?")
      .bind(patch.vodUrl, now, id)
      .run();
    return (await getEvent(env, id, now))!;
  }
  const topics = await validTopics(env, row.streamer_id, patch.topicIds);
  const regenerate = patch.repeatDays > 0 && (patch.scope === "following" || row.series_id === null);
  if (!regenerate && !(patch.scope === "following" && row.series_id !== null)) {
    // One stream: update the row in place. An occurrence keeps its series; its repeat settings stay.
    const first = parseDate(patch.date)!;
    const [hour, minute] = patch.time.split(":").map(Number);
    const start = zonedTime(first, hour, minute, patch.tz);
    await env.DB.batch([
      env.DB.prepare(`UPDATE stream_events SET title=?, notes=?, starts_at=?, duration_min=?, platform=?, url=?, tz=?,
        status=CASE WHEN status='cancelled' THEN 'cancelled' ELSE 'scheduled' END, is_exception=1, updated_at=?
        WHERE id=?`).bind(
        patch.title,
        patch.notes,
        start,
        patch.durationMin,
        patch.platform,
        patch.url,
        patch.tz,
        now,
        id,
      ),
      env.DB.prepare("DELETE FROM stream_event_topics WHERE event_id=?").bind(id),
      env.DB.prepare(
        "INSERT OR IGNORE INTO stream_event_topics (event_id,entry_id) SELECT ?, value FROM json_each(?)",
      ).bind(id, JSON.stringify(topics)),
    ]);
    return (await getEvent(env, id, now))!;
  }
  // This and the following: replace the rest of the series (or a one-off) with the new plan.
  const plan = planEvents(patch, now, patch.repeatDays > 0 ? (row.series_id ?? null) : null);
  const removal =
    row.series_id === null
      ? env.DB.prepare("DELETE FROM stream_events WHERE id=?").bind(id)
      : env.DB.prepare("DELETE FROM stream_events WHERE series_id=? AND starts_at >= ?").bind(
          row.series_id,
          row.starts_at,
        );
  const freed = await env.DB.prepare(
    row.series_id === null
      ? "SELECT count(*) AS n FROM stream_events WHERE id=? AND starts_at >= ?"
      : "SELECT count(*) AS n FROM stream_events WHERE series_id=? AND starts_at >= max(?, ?)",
  )
    .bind(...(row.series_id === null ? [id, now] : [row.series_id, row.starts_at, now]))
    .first<{ n: number }>();
  await assertRoom(env, row.streamer_id, plan.starts.length, now, freed?.n ?? 0);
  const { statements, ids } = insertStatements(env, row.streamer_id, templateOf(patch), plan, topics, now, "replace");
  const ending = row.series_id === null ? [] : [endSeriesBefore(env, row.series_id, row)];
  await env.DB.batch([removal, ...ending, ...statements]);
  return (await getEvent(env, ids[0], now))!;
}

/** `DELETE /api/events/:id`: this stream, or this and the following ones of its series. */
export async function deleteEvent(env: AppEnv, viewerId: string, id: string, value: unknown): Promise<void> {
  const { scope } = parsed(eventDeleteSchema, value ?? {});
  const row = await ownedEvent(env, viewerId, id);
  await assertStreamerWritable(env, row.streamer_id, viewerId);
  await consumeMutationQuota(env, viewerId);
  if (scope === "following" && row.series_id) {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM stream_events WHERE series_id=? AND starts_at >= ?").bind(
        row.series_id,
        row.starts_at,
      ),
      endSeriesBefore(env, row.series_id, row),
    ]);
  } else {
    await env.DB.prepare("DELETE FROM stream_events WHERE id=?").bind(id).run();
  }
}

/**
 * Hourly cron: keeps every open-ended or not-yet-finished series written 12 weeks ahead and deletes streams past
 * the retention window. New occurrences follow the day after the series is written through (its latest occurrence,
 * or a later one deleted on its own); the template (title, wall-clock time in its zone, end date) is its latest
 * occurrence that was neither edited on its own nor cancelled.
 * Returns how many occurrences were added.
 */
export async function topUpSeries(env: AppEnv, now: number, maxSeries = 50): Promise<number> {
  const horizon = now + SERIES_HORIZON_MS;
  const { results } = await env.DB.prepare(`SELECT x.*, s.last FROM stream_events x
    JOIN (SELECT g.series_id, max(g.last, coalesce(w.written_through, 0)) AS last
      FROM (SELECT series_id, max(starts_at) AS last FROM stream_events
        WHERE series_id IS NOT NULL GROUP BY series_id) g
      LEFT JOIN stream_series w ON w.id=g.series_id) s
      ON s.series_id=x.series_id
    WHERE s.last < ? AND (x.repeat_until IS NULL OR x.repeat_until > s.last)
      AND x.starts_at=(SELECT max(y.starts_at) FROM stream_events y
        WHERE y.series_id=x.series_id AND y.is_exception=0 AND y.status<>'cancelled')
    LIMIT ?`)
    .bind(horizon - 86_400_000, maxSeries)
    .all<EventRow & { last: number }>();
  let added = 0;
  for (const template of results) {
    const local = zonedParts(template.starts_at, template.tz);
    const until = template.repeat_until === null ? null : localDateOf(template.repeat_until, template.tz);
    const starts = expandSeries(
      {
        first: addDays(localDateOf(template.last, template.tz), 1),
        hour: local.hour,
        minute: local.minute,
        zone: template.tz,
        days: template.repeat_days,
        until,
      },
      horizon,
    ).filter((start: number): boolean => start > template.last);
    if (starts.length === 0) continue;
    const topics = (await topicsFor(env, [template.id])).get(template.id) ?? [];
    const { statements } = insertStatements(
      env,
      template.streamer_id,
      {
        title: template.title,
        notes: template.notes,
        durationMin: template.duration_min,
        platform: template.platform,
        url: template.url,
        tz: template.tz,
      },
      {
        starts,
        seriesId: template.series_id,
        repeatDays: template.repeat_days,
        repeatUntil: template.repeat_until,
      },
      topics.map((topic: EventTopic): string => topic.id),
      now,
    );
    await env.DB.batch(statements);
    added += starts.length;
  }
  await env.DB.batch([
    env.DB.prepare(
      "DELETE FROM stream_events WHERE id IN (SELECT id FROM stream_events WHERE starts_at < ? LIMIT 5000)",
    ).bind(now - EVENT_RETENTION_MS),
    env.DB.prepare(
      "DELETE FROM stream_series WHERE NOT EXISTS(SELECT 1 FROM stream_events e WHERE e.series_id=stream_series.id)",
    ),
  ]);
  return added;
}

/** The feed's caps: every upcoming stream a page can hold (`topUpSeries` may pass 400), then recent past ones. */
export const FEED_UPCOMING_LIMIT = 500;
export const FEED_PAST_LIMIT = 100;

/**
 * The `.ics` feed: 30 days back and the 12 weeks ahead, cancelled streams included as `STATUS:CANCELLED`. Upcoming
 * and past streams are read apart, so old streams never push the furthest upcoming ones out of the feed (review m12).
 */
export async function scheduleCalendar(
  env: AppEnv,
  streamer: { id: string; name: string; handle: string },
  origin: string,
  now: number = Date.now(),
): Promise<string> {
  const [upcoming, past] = await env.DB.batch<EventRow>([
    env.DB.prepare(`SELECT * FROM stream_events WHERE streamer_id=? AND starts_at >= ? AND starts_at < ?
      ORDER BY starts_at, id LIMIT ?`).bind(
      streamer.id,
      now,
      now + SERIES_HORIZON_MS + 7 * 86_400_000,
      FEED_UPCOMING_LIMIT,
    ),
    env.DB.prepare(`SELECT * FROM stream_events WHERE streamer_id=? AND starts_at >= ? AND starts_at < ?
      ORDER BY starts_at DESC, id DESC LIMIT ?`).bind(streamer.id, now - 30 * 86_400_000, now, FEED_PAST_LIMIT),
  ]);
  const results: EventRow[] = [...past.results].reverse().concat(upcoming.results);
  const events: IcsEvent[] = results.map(
    (row: EventRow): IcsEvent => ({
      id: row.id,
      title: row.title,
      notes: row.notes,
      startsAt: row.starts_at,
      durationMin: row.duration_min,
      url: row.url,
      cancelled: row.status === "cancelled",
      updatedAt: row.updated_at,
    }),
  );
  return buildCalendar(streamer.name, events, { pageUrl: `${origin}/@${streamer.handle}`, now });
}
