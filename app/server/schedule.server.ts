import { z } from "zod";
import type { AppEnv } from "../env";
import { effectiveStatus, expandSeries, SERIES_HORIZON_MS, type SeriesRule } from "../lib/schedule";
import { addDays, localDateOf, parseDate, weekdayOf, zonedParts, zonedTime, type LocalDate } from "../lib/zoned";
import type { EventTopic, StreamEvent, StreamEventStatus, StreamPlatform } from "../types";
import { assertStreamerWritable } from "./access.server";
import { consumeMutationQuota } from "./data.server";
import { HttpError } from "./http.server";
import { refreshPageOverlay } from "./overlay.server";
import { buildCalendar, type IcsEvent } from "./ics";
import { eventDeleteSchema, eventInputSchema, eventPatchSchema, type EventInput, type EventPatch } from "./validation";

/**
 * Upcoming streams a page may hold at once (a few series plus one-offs). Creating and editing refuse past it and the
 * cron stops writing at it, so the read limit (`UPCOMING_LIMIT`, above it) always shows every one.
 */
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
  if (ids.length === 0) return new Map<string, EventTopic[]>();
  const map = new Map<string, EventTopic[]>(ids.map((id: string): [string, EventTopic[]] => [id, []]));
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

/** Upcoming streams read at most: more than `MAX_UPCOMING_EVENTS`, which no write passes. */
export const UPCOMING_LIMIT = 500;
/** Past streams the schedule shows at most, newest kept. */
export const PAST_LIMIT = 200;

/**
 * Rows that overlap `[from, to)`, oldest first. Upcoming and past rows are read apart, so old streams never push
 * the furthest upcoming ones out (review m12); past rows are read newest first and keep the latest `past`.
 */
async function eventRows(
  env: AppEnv,
  streamerId: string,
  range: { from: number; to: number; now: number },
  limits: { upcoming: number; past: number },
): Promise<EventRow[]> {
  const overlap = "streamer_id=? AND starts_at < ? AND starts_at + duration_min * 60000 > ?";
  const [upcoming, past] = await env.DB.batch<EventRow>([
    env.DB.prepare(`SELECT * FROM stream_events WHERE ${overlap} AND starts_at >= ?
      ORDER BY starts_at, id LIMIT ?`).bind(streamerId, range.to, range.from, range.now, limits.upcoming),
    env.DB.prepare(`SELECT * FROM stream_events WHERE ${overlap} AND starts_at < ?
      ORDER BY starts_at DESC, id DESC LIMIT ?`).bind(streamerId, range.to, range.from, range.now, limits.past),
  ]);
  return [...past.results].reverse().concat(upcoming.results);
}

/** Streams that overlap `[from, to)`, oldest first: up to 500 from `now` on and the 200 latest before it. */
export async function listEvents(
  env: AppEnv,
  streamerId: string,
  from: number,
  to: number,
  now: number = Date.now(),
): Promise<StreamEvent[]> {
  const results = await eventRows(env, streamerId, { from, to, now }, { upcoming: UPCOMING_LIMIT, past: PAST_LIMIT });
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
  if (row?.owner_id !== viewerId) throw new HttpError(404, "Stream not found.");
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
  /** The series has no stream left after these before its end date. */
  done?: boolean;
  /** The series' wall-clock time, when known: a stream in the spring gap is stored an hour later than it. */
  time?: { hour: number; minute: number };
}

/** Whether a series with an end date has no stream left after `after`. */
function seriesDone(rule: SeriesRule, after: number): boolean {
  if (rule.until === null) return false;
  const next = { ...rule, first: addDays(localDateOf(after, rule.zone), 1) };
  return expandSeries(next, Number.POSITIVE_INFINITY, 1).length === 0;
}

/**
 * Turns the form into start times. A weekly series always includes the first date's weekday and is written
 * 12 weeks ahead (or to its end date); the cron writes the rest as time passes.
 */
export function planEvents(input: EventInput, now: number, seriesId: string | null = null): Plan {
  const first = parseDate(input.date);
  if (!first) throw new HttpError(400, "Pick a valid date.", "invalid_schedule_date");
  const [hour, minute] = input.time.split(":").map(Number);
  const start = zonedTime(first, hour, minute, input.tz);
  if (input.repeatDays === 0) return { starts: [start], seriesId: null, repeatDays: 0, repeatUntil: null };
  const days = input.repeatDays | (1 << weekdayOf(first));
  const until: LocalDate | null = input.repeatUntil ? parseDate(input.repeatUntil) : null;
  if (
    until &&
    until.year * 10_000 + until.month * 100 + until.day < first.year * 10_000 + first.month * 100 + first.day
  )
    throw new HttpError(400, "The end date is before the first stream.", "invalid_schedule_date");
  const repeatUntil = until ? zonedTime(addDays(until, 1), 0, 0, input.tz) - 1 : null;
  const rule: SeriesRule = { first, hour, minute, zone: input.tz, days, until };
  const starts = expandSeries(rule, Math.max(now + SERIES_HORIZON_MS, start + 1));
  if (starts.length === 0) throw new HttpError(400, "No stream falls on the chosen days before the end date.", "schedule_no_occurrences");
  const done = seriesDone(rule, starts.at(-1)!);
  return {
    starts,
    seriesId: seriesId ?? crypto.randomUUID(),
    repeatDays: days,
    repeatUntil,
    done,
    time: { hour, minute },
  };
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
 * Inserts the plan's streams and, for a series, records how far it is written and the template later streams copy
 * (`stream_series`). `replace` is for a series rewritten from one of its streams onwards; otherwise the mark only
 * moves forward.
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
          `INSERT OR IGNORE INTO stream_event_topics (event_id,entry_id) SELECT ?, value FROM json_each(?)
            WHERE value IN (SELECT id FROM entries)`,
        ).bind(id, JSON.stringify(topicIds)),
      );
  }
  // A finished series is marked as written through its end date, so the cron never picks it again.
  const mark = plan.done && plan.repeatUntil !== null ? plan.repeatUntil : Math.max(...plan.starts);
  if (plan.seriesId !== null && (plan.starts.length > 0 || plan.done))
    statements.push(
      env.DB.prepare(`INSERT INTO stream_series (id,streamer_id,written_through,hour,minute,title,notes,duration_min,
          platform,url,tz,repeat_days,repeat_until,topics) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET written_through=${
          through === "replace" ? "excluded.written_through" : "max(written_through, excluded.written_through)"
        }, hour=coalesce(excluded.hour, hour), minute=coalesce(excluded.minute, minute), title=excluded.title,
          notes=excluded.notes, duration_min=excluded.duration_min, platform=excluded.platform, url=excluded.url,
          tz=excluded.tz, repeat_days=excluded.repeat_days, repeat_until=excluded.repeat_until,
          topics=excluded.topics`).bind(
        plan.seriesId,
        streamerId,
        mark,
        plan.time?.hour ?? null,
        plan.time?.minute ?? null,
        template.title,
        template.notes,
        template.durationMin,
        template.platform,
        template.url,
        template.tz,
        plan.repeatDays,
        plan.repeatUntil,
        JSON.stringify(topicIds),
      ),
    );
  return { statements, ids };
}

/**
 * Ends a series on the day before `row`: the occurrences that stay and the series' template get that end date (like
 * one picked in the form), so the cron never writes the deleted or replaced ones again.
 */
function endSeriesBefore(env: AppEnv, seriesId: string, row: { starts_at: number; tz: string }): D1PreparedStatement[] {
  const until = zonedTime(localDateOf(row.starts_at, row.tz), 0, 0, row.tz) - 1;
  return [
    env.DB.prepare(`UPDATE stream_events SET repeat_until=?
      WHERE series_id=? AND starts_at < ? AND (repeat_until IS NULL OR repeat_until > ?)`).bind(
      until,
      seriesId,
      row.starts_at,
      until,
    ),
    env.DB.prepare(
      "UPDATE stream_series SET repeat_until=? WHERE id=? AND (repeat_until IS NULL OR repeat_until > ?)",
    ).bind(until, seriesId, until),
  ];
}

const UPCOMING_COUNT = "SELECT count(*) AS n FROM stream_events WHERE streamer_id=? AND starts_at >= ?";

async function upcomingCount(env: AppEnv, streamerId: string, now: number): Promise<number> {
  const row = await env.DB.prepare(UPCOMING_COUNT).bind(streamerId, now).first<{ n: number }>();
  return row?.n ?? 0;
}

function fullSchedule(): HttpError {
  return new HttpError(409, `A schedule can hold up to ${MAX_UPCOMING_EVENTS} upcoming streams.`);
}

/** Fast check before the work; `capacityGuard` in the same batch as the writes is what holds the cap. */
async function assertRoom(env: AppEnv, streamerId: string, adding: number, now: number, freed = 0): Promise<void> {
  if ((await upcomingCount(env, streamerId, now)) - freed + adding > MAX_UPCOMING_EVENTS) throw fullSchedule();
}

/** Path of the bad-path error `capacityGuard` raises; `isCapacityError` looks for it. */
const OVER_CAPACITY = "schedule over capacity";

/**
 * Last statement of a batch that adds upcoming streams: it fails, rolling the whole batch back, when the page then
 * holds more than `MAX_UPCOMING_EVENTS`. A batch is one transaction, so writes that passed `assertRoom` at the same
 * time cannot together pass the cap. SQLite has no RAISE outside triggers, so a bad JSON path makes the error.
 */
function capacityGuard(env: AppEnv, streamerId: string, now: number): D1PreparedStatement {
  return env.DB.prepare(
    `SELECT CASE WHEN (${UPCOMING_COUNT}) > ? THEN json_extract('{}', '${OVER_CAPACITY}') ELSE 1 END`,
  ).bind(streamerId, now, MAX_UPCOMING_EVENTS);
}

/** Whether a batch failed on the guard that raises the bad-path error `marker`. */
function failedGuard(error: unknown, marker: string): boolean {
  if (!(error instanceof Error)) return false;
  const cause = error.cause instanceof Error ? error.cause.message : "";
  return `${error.message} ${cause}`.includes(`bad JSON path: '${marker}'`);
}

/** Whether a batch failed on its `capacityGuard`. */
function isCapacityError(error: unknown): boolean {
  return failedGuard(error, OVER_CAPACITY);
}

/** Runs a batch that ends with `capacityGuard`, reporting a full page like `assertRoom`. */
async function guardedBatch(env: AppEnv, statements: D1PreparedStatement[]): Promise<void> {
  try {
    await env.DB.batch(statements);
  } catch (error: unknown) {
    if (isCapacityError(error)) throw fullSchedule();
    throw error;
  }
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
  await guardedBatch(env, [...statements, capacityGuard(env, streamerId, now)]);
  const created = await getEvent(env, ids[0], now);
  if (!created) throw new Error("The stream was not saved.");
  return created;
}

/** One stream by id; with `streamerId`, only when it belongs to that page (a shared link names any id). */
export async function getEvent(
  env: AppEnv,
  id: string,
  now: number = Date.now(),
  streamerId: string | null = null,
): Promise<StreamEvent | null> {
  const row = await env.DB.prepare("SELECT * FROM stream_events WHERE id=?1 AND (?2 IS NULL OR streamer_id=?2)")
    .bind(id, streamerId)
    .first<EventRow>();
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
  return editEvent(env, id, row, patch, now);
}

async function editOneEvent(
  env: AppEnv,
  id: string,
  row: OwnedEventRow,
  patch: Extract<EventPatch, { action: "edit" }>,
  topics: string[],
  now: number,
): Promise<StreamEvent> {
  // One stream: update the row in place. An occurrence keeps its series; its repeat settings stay.
  const first = parseDate(patch.date)!;
  const [hour, minute] = patch.time.split(":").map(Number);
  const start = zonedTime(first, hour, minute, patch.tz);
  // A past stream moved into the future adds one upcoming stream; any other move keeps the count.
  const adds = row.starts_at < now && start >= now;
  if (adds) await assertRoom(env, row.streamer_id, 1, now);
  await guardedBatch(env, [
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
    ...(adds ? [capacityGuard(env, row.streamer_id, now)] : []),
  ]);
  return (await getEvent(env, id, now))!;
}

async function editEvent(
  env: AppEnv,
  id: string,
  row: OwnedEventRow,
  patch: Extract<EventPatch, { action: "edit" }>,
  now: number,
): Promise<StreamEvent> {
  const topics = await validTopics(env, row.streamer_id, patch.topicIds);
  const regenerate = patch.repeatDays > 0 && (patch.scope === "following" || row.series_id === null);
  if (!regenerate && !(patch.scope === "following" && row.series_id !== null)) {
    return editOneEvent(env, id, row, patch, topics, now);
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
  const ending = row.series_id === null ? [] : endSeriesBefore(env, row.series_id, row);
  await guardedBatch(env, [removal, ...ending, ...statements, capacityGuard(env, row.streamer_id, now)]);
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
      ...endSeriesBefore(env, row.series_id, row),
    ]);
  } else {
    await env.DB.prepare("DELETE FROM stream_events WHERE id=?").bind(id).run();
  }
}

/** A series as the cron extends it: its template, its time of day and how far it is written. */
interface SeriesTemplate {
  series_id: string;
  streamer_id: string;
  title: string;
  notes: string;
  duration_min: number;
  platform: StreamPlatform;
  url: string;
  tz: string;
  repeat_days: number;
  repeat_until: number | null;
  hour: number | null;
  minute: number | null;
  /** The template stream of a series written before 0018; null for one with a stored template. */
  starts_at: number | null;
  /** JSON array of topic entry ids. */
  topics: string;
  last: number;
}

/** The `series` the cron reads (`SERIES_TEMPLATES`), with `only` naming the one series to read. */
function seriesCte(only: string | null): string {
  const one = (column: string): string => (only === null ? "" : ` AND ${column}=${only}`);
  return `marks AS (
    SELECT series_id, max(starts_at) AS last FROM stream_events
    WHERE series_id IS NOT NULL AND is_exception=0${one("series_id")} GROUP BY series_id
  ), series AS (
    SELECT w.id AS series_id, w.streamer_id, w.title, w.notes, w.duration_min, w.platform, w.url, w.tz,
      w.repeat_days, w.repeat_until, w.hour, w.minute, NULL AS starts_at, w.topics,
      max(w.written_through, coalesce(m.last, 0)) AS last
    FROM stream_series w LEFT JOIN marks m ON m.series_id=w.id WHERE w.title IS NOT NULL${one("w.id")}
    UNION ALL
    SELECT x.series_id, x.streamer_id, x.title, x.notes, x.duration_min, x.platform, x.url, x.tz,
      x.repeat_days, x.repeat_until, w.hour, w.minute, x.starts_at,
      (SELECT json_group_array(t.entry_id) FROM stream_event_topics t JOIN entries e ON e.id=t.entry_id
        WHERE t.event_id=x.id) AS topics,
      max(m.last, coalesce(w.written_through, 0)) AS last
    FROM stream_events x JOIN marks m ON m.series_id=x.series_id LEFT JOIN stream_series w ON w.id=x.series_id
    WHERE w.title IS NULL${one("x.series_id")} AND x.starts_at=(SELECT max(y.starts_at) FROM stream_events y
      WHERE y.series_id=x.series_id AND y.is_exception=0 AND y.status<>'cancelled')
  )`;
}

/** Path of the bad-path error `freshGuard` raises. */
const STALE_SERIES = "series changed since read";

/**
 * First statement of a top-up batch: it fails, rolling the batch back, unless the cron would still read the series
 * exactly as `template`. An edit or end of the series, or another top-up of it, committed after the cron read it
 * changes its template, end date or how far it is written, so stale settings and streams are never written.
 */
function freshGuard(env: AppEnv, template: SeriesTemplate): D1PreparedStatement {
  return env.DB.prepare(`WITH ${seriesCte("?1")}
    SELECT CASE WHEN EXISTS(SELECT 1 FROM series WHERE series_id=?1 AND streamer_id IS ?2 AND title IS ?3
      AND notes IS ?4 AND duration_min IS ?5 AND platform IS ?6 AND url IS ?7 AND tz IS ?8 AND repeat_days IS ?9
      AND repeat_until IS ?10 AND hour IS ?11 AND minute IS ?12 AND starts_at IS ?13 AND topics IS ?14
      AND last IS ?15) THEN 1 ELSE json_extract('{}', '${STALE_SERIES}') END`).bind(
    template.series_id,
    template.streamer_id,
    template.title,
    template.notes,
    template.duration_min,
    template.platform,
    template.url,
    template.tz,
    template.repeat_days,
    template.repeat_until,
    template.hour,
    template.minute,
    template.starts_at,
    template.topics,
    template.last,
  );
}

/** Writes a series' streams up to `horizon`; marks it finished when none are left. Returns how many it added. */
async function topUpOne(env: AppEnv, template: SeriesTemplate, horizon: number, now: number): Promise<number> {
  // A series written before its time was stored falls back to its template stream's local time.
  const local = template.hour === null ? zonedParts(template.starts_at!, template.tz) : null;
  const rule: SeriesRule = {
    first: addDays(localDateOf(template.last, template.tz), 1),
    hour: template.hour ?? local!.hour,
    minute: template.minute ?? local!.minute,
    zone: template.tz,
    days: template.repeat_days,
    until: template.repeat_until === null ? null : localDateOf(template.repeat_until, template.tz),
  };
  const due = expandSeries(rule, horizon).filter((start: number): boolean => start > template.last);
  // A series that starts past the horizon passed the cap with one stream; writing the rest stops at the cap, and a
  // later run goes on from the last one written once the page has room again.
  const room = due.length === 0 ? 0 : MAX_UPCOMING_EVENTS - (await upcomingCount(env, template.streamer_id, now));
  const starts = due.slice(0, Math.max(0, room));
  const done = starts.length === due.length && seriesDone(rule, due.at(-1) ?? template.last);
  if (starts.length === 0 && !done) return 0;
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
      done,
      time: { hour: rule.hour, minute: rule.minute },
    },
    z.array(z.string()).parse(JSON.parse(template.topics)),
    now,
  );
  const capacity = starts.length > 0 ? [capacityGuard(env, template.streamer_id, now)] : [];
  try {
    await env.DB.batch([freshGuard(env, template), ...statements, ...capacity]);
  } catch (error: unknown) {
    // The owner changed the series, or another write filled the page, after it was read: a later run goes on from
    // what is stored then.
    if (failedGuard(error, STALE_SERIES) || isCapacityError(error)) return 0;
    throw error;
  }
  return starts.length;
}

/** Pages of `maxSeries` the cron reads at most per run while looking for series that need streams. */
const TOP_UP_PAGES = 20;

/**
 * Every series as the cron extends it, in id order. Since 0018 a series keeps its template in `stream_series`, so
 * editing or cancelling its streams one by one never changes or hides it. A series written before 0018 copies its
 * latest stream neither edited on its own nor cancelled (it gets a stored template on its first top-up). Either way
 * it is written through its latest stream not edited on its own, or the stored mark when that is later (a stream
 * deleted or moved on its own). A series whose page is at the cap is skipped: it could add nothing, and reading it
 * would spend the run's pages before the series after it.
 */
const SERIES_TEMPLATES = `WITH ${seriesCte(null)}
  SELECT * FROM series WHERE last < ? AND (repeat_until IS NULL OR repeat_until > last) AND series_id > ?
    AND (SELECT count(*) FROM stream_events u WHERE u.streamer_id=series.streamer_id AND u.starts_at >= ?) < ?
  ORDER BY series_id LIMIT ?`;

/**
 * Hourly cron: keeps every open-ended or not-yet-finished series written 12 weeks ahead (`SERIES_TEMPLATES` says
 * from what) and deletes streams past the retention window. Series with nothing to add yet do not count towards
 * `maxSeries`, so they never hold back the ones after them; finished ones are marked and not read again.
 * Returns how many occurrences were added.
 */
export async function topUpSeries(env: AppEnv, now: number, maxSeries = 50): Promise<number> {
  const horizon = now + SERIES_HORIZON_MS;
  let added = 0;
  let written = 0;
  let cursor = "";
  const pages = new Set<string>();
  for (let page = 0; page < TOP_UP_PAGES && written < maxSeries; page += 1) {
    const { results } = await env.DB.prepare(SERIES_TEMPLATES)
      .bind(horizon - 86_400_000, cursor, now, MAX_UPCOMING_EVENTS, maxSeries)
      .all<SeriesTemplate>();
    for (const template of results) {
      const count = await topUpOne(env, template, horizon, now);
      added += count;
      if (count > 0) {
        written += 1;
        pages.add(template.streamer_id);
      }
    }
    if (results.length < maxSeries) break;
    cursor = results.at(-1)!.series_id;
  }
  await env.DB.batch([
    env.DB.prepare(
      "DELETE FROM stream_events WHERE id IN (SELECT id FROM stream_events WHERE starts_at < ? LIMIT 5000)",
    ).bind(now - EVENT_RETENTION_MS),
    // A series with no streams left goes only when it cannot write any again: a stored template keeps an open one
    // going (its only stream may have been deleted on its own) until its end date has passed or was set before it.
    env.DB.prepare(`DELETE FROM stream_series
      WHERE NOT EXISTS(SELECT 1 FROM stream_events e WHERE e.series_id=stream_series.id)
        AND (title IS NULL OR repeat_until < ? OR repeat_until < written_through)`).bind(now),
  ]);
  // New streams may be the next one, so an overlay showing Up next reloads, as after the owner's own writes.
  for (const page of pages) await refreshPageOverlay(env, page, ["next"]);
  return added;
}

/** The feed keeps fewer past streams than the page. */
export const FEED_PAST_LIMIT = 100;

/**
 * The `.ics` feed: 30 days back and the 12 weeks ahead, cancelled streams included as `STATUS:CANCELLED`, with
 * every upcoming stream and the latest past ones.
 */
export async function scheduleCalendar(
  env: AppEnv,
  streamer: { id: string; name: string; handle: string },
  origin: string,
  now: number = Date.now(),
): Promise<string> {
  const results = await eventRows(
    env,
    streamer.id,
    { from: now - 30 * 86_400_000, to: now + SERIES_HORIZON_MS + 7 * 86_400_000, now },
    { upcoming: UPCOMING_LIMIT, past: FEED_PAST_LIMIT },
  );
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
