import { waitUntil } from "cloudflare:workers";
import { z } from "zod";
import type { AppEnv } from "../env";
import { IMPORT_HORIZON_MS, importedStreamSchema, type ImportedStream } from "./channel-providers.server";
import { activityAvailable } from "./channel-tokens.server";
import { logError } from "./http.server";
import { callIngest } from "./ingest-call.server";
import { refreshPageOverlay } from "./overlay.server";
import { capacityGuard, isCapacityError, MAX_UPCOMING_EVENTS } from "./schedule.server";

/**
 * Reads the scheduled streams of a page's connected Twitch and YouTube channels into its schedule. Each read
 * stream keeps a row in `stream_event_sources`, so a new read updates its entry and never adds a second one. A
 * stream of a second platform with the same start (at most 15 minutes apart) joins that entry, whatever its title:
 * a streamer runs one stream at a time, and the platforms often carry different titles for it.
 * The import changes only entries it created and the owner did not edit (`imported`). Kick has no schedule API.
 */

type ImportPlatform = "twitch" | "youtube";
const IMPORT_PLATFORMS: readonly ImportPlatform[] = ["twitch", "youtube"];

/** Two entries are one stream when their starts are at most this far apart. */
export const MATCH_WINDOW_MS = 15 * 60_000;
/** A stream that starts this soon can be live already, and a provider can stop listing it: no read removes it. */
export const KEEP_MARGIN_MS = 60 * 60_000;
/** The owner's visits to the schedule start a read at most this often. */
export const OWNER_READ_INTERVAL_MS = 10 * 60_000;
/** The hourly job reads a page again after this time. */
export const CRON_READ_INTERVAL_MS = 6 * 3_600_000;
/** Pages the hourly job reads in one run. */
export const CRON_PAGES = 25;
/** A source that no read found again for this time is deleted, like other stored YouTube data. */
export const SOURCE_RETENTION_MS = 30 * 86_400_000;

export function sameStream(a: { startsAt: number }, b: { startsAt: number }): boolean {
  return Math.abs(a.startsAt - b.startsAt) <= MATCH_WINDOW_MS;
}

const readSchema = z.object({ streams: z.array(importedStreamSchema).max(200).nullable() });

/** Synthetic streams for the test deployment, which reads no provider. */
export function testStreams(platform: ImportPlatform, now: number): ImportedStream[] {
  const day = Math.floor(now / 86_400_000) * 86_400_000;
  const url =
    platform === "twitch" ? "https://www.twitch.tv/test_channel" : "https://www.youtube.com/watch?v=test-video";
  return [
    {
      externalId: `${platform}-test-1`,
      title: "Test stream",
      startsAt: day + 2 * 86_400_000 + 18 * 3_600_000,
      durationMin: 120,
      url,
    },
    {
      externalId: `${platform}-test-2`,
      title: `${platform === "twitch" ? "Twitch" : "YouTube"} only`,
      startsAt: day + 3 * 86_400_000 + (platform === "twitch" ? 18 : 20) * 3_600_000,
      durationMin: 90,
      url,
    },
  ];
}

/** The scheduled streams of the page's channel on `platform`, or null when they cannot be read now. */
async function readStreams(
  env: AppEnv,
  streamerId: string,
  platform: ImportPlatform,
  now: number,
): Promise<ImportedStream[] | null> {
  if (env.APP_ENV === "test") return testStreams(platform, now);
  const response = await callIngest(env, streamerId, "upcoming", { platform });
  if (!response.ok) return null;
  const body = readSchema.safeParse(await response.json());
  return body.success ? body.data.streams : null;
}

interface SourceRow {
  external_id: string;
  event_id: string | null;
  imported: number | null;
  event_platform: string | null;
  title: string | null;
  starts_at: number | null;
  duration_min: number | null;
  url: string | null;
}

interface Candidate {
  id: string;
  starts_at: number;
}

/** One platform's read of one page, with the statements it collects for one batch. */
interface Sync {
  env: AppEnv;
  streamerId: string;
  platform: ImportPlatform;
  now: number;
  known: Map<string, SourceRow>;
  // Entries without a source of this platform that a read stream can join.
  free: Candidate[];
  // New upcoming entries the page has room for, and whether the batch adds one.
  room: number;
  adds: boolean;
  statements: D1PreparedStatement[];
  changed: boolean;
}

async function startSync(env: AppEnv, streamerId: string, platform: ImportPlatform, now: number): Promise<Sync> {
  const [sources, candidates, upcoming] = await env.DB.batch([
    env.DB.prepare(`SELECT s.external_id, s.event_id, e.imported, e.platform AS event_platform, e.title, e.starts_at,
        e.duration_min, e.url
      FROM stream_event_sources s LEFT JOIN stream_events e ON e.id=s.event_id
      WHERE s.streamer_id=? AND s.platform=?`).bind(streamerId, platform),
    env.DB.prepare(`SELECT id, starts_at FROM stream_events e WHERE streamer_id=? AND starts_at >= ? AND starts_at < ?
        AND NOT EXISTS(SELECT 1 FROM stream_event_sources s WHERE s.event_id=e.id AND s.platform=?)
      ORDER BY starts_at, id`).bind(streamerId, now - 86_400_000, now + IMPORT_HORIZON_MS + MATCH_WINDOW_MS, platform),
    env.DB.prepare("SELECT count(*) AS n FROM stream_events WHERE streamer_id=? AND starts_at >= ?").bind(
      streamerId,
      now,
    ),
  ]);
  return {
    env,
    streamerId,
    platform,
    now,
    known: new Map<string, SourceRow>(
      (sources.results as SourceRow[]).map((row: SourceRow): [string, SourceRow] => [row.external_id, row]),
    ),
    free: candidates.results as Candidate[],
    room: MAX_UPCOMING_EVENTS - ((upcoming.results[0] as { n: number } | undefined)?.n ?? 0),
    statements: [],
    changed: false,
    adds: false,
  };
}

function outdated(source: SourceRow, stream: ImportedStream): boolean {
  return (
    source.title !== stream.title ||
    source.starts_at !== stream.startsAt ||
    source.duration_min !== stream.durationMin ||
    source.url !== stream.url
  );
}

/** A stream read before: its source is fresh again, and its entry follows the read while the import owns it. */
function readAgain(sync: Sync, source: SourceRow, stream: ImportedStream): void {
  const { env } = sync;
  sync.statements.push(
    env.DB.prepare(
      "UPDATE stream_event_sources SET url=?, read_at=? WHERE streamer_id=? AND platform=? AND external_id=?",
    ).bind(stream.url, sync.now, sync.streamerId, sync.platform, stream.externalId),
  );
  // Only the platform that created an entry changes it, and only until the owner edits it.
  if (source.event_id === null || source.imported !== 1 || source.event_platform !== sync.platform) return;
  if (!outdated(source, stream)) return;
  // A stream that moves from the past into the future takes room like a new one; a full page keeps the entry.
  if (!takeRoom(sync, (source.starts_at ?? 0) < sync.now && stream.startsAt >= sync.now)) return;
  sync.changed = true;
  sync.statements.push(
    env.DB.prepare(`UPDATE stream_events SET title=?, starts_at=?, duration_min=?, url=?, updated_at=?
      WHERE id=? AND imported=1 AND platform=?`).bind(
      stream.title,
      stream.startsAt,
      stream.durationMin,
      stream.url,
      sync.now,
      source.event_id,
      sync.platform,
    ),
  );
}

/** Takes room for one more upcoming entry when `upcoming`. False when the page is full. */
function takeRoom(sync: Sync, upcoming: boolean): boolean {
  if (!upcoming) return true;
  if (sync.room <= 0) return false;
  sync.room -= 1;
  sync.adds = true;
  return true;
}

/** The entry for a new stream: the same stream of another platform, or a new imported entry. Null when full. */
function entryFor(sync: Sync, stream: ImportedStream): string | null {
  const index = sync.free.findIndex((candidate: Candidate): boolean =>
    sameStream({ startsAt: candidate.starts_at }, stream),
  );
  if (index >= 0) return sync.free.splice(index, 1)[0].id;
  if (!takeRoom(sync, stream.startsAt >= sync.now)) return null;
  const id = crypto.randomUUID();
  sync.statements.push(
    sync.env.DB.prepare(`INSERT INTO stream_events (id,streamer_id,title,starts_at,duration_min,platform,url,tz,imported,
        created_at,updated_at) VALUES (?,?,?,?,?,?,?,'UTC',1,?,?)`).bind(
      id,
      sync.streamerId,
      stream.title,
      stream.startsAt,
      stream.durationMin,
      sync.platform,
      stream.url,
      sync.now,
      sync.now,
    ),
  );
  return id;
}

function readNew(sync: Sync, stream: ImportedStream): void {
  const eventId = entryFor(sync, stream);
  // A full schedule takes no new entry; the next read tries again.
  if (eventId === null) return;
  sync.changed = true;
  sync.statements.push(
    sync.env.DB.prepare(`INSERT INTO stream_event_sources (streamer_id,platform,external_id,event_id,url,read_at)
      VALUES (?,?,?,?,?,?)`).bind(sync.streamerId, sync.platform, stream.externalId, eventId, stream.url, sync.now),
  );
}

/**
 * A stream the read no longer lists. Its link goes when it starts in more than an hour and inside the read, and
 * the entry goes with it when the import created it and no other platform holds it. A link that the owner deleted
 * the entry of goes too. A stream that started or lies past the read keeps its link.
 */
function notRead(sync: Sync, source: SourceRow): void {
  const start = source.starts_at;
  const waiting = start !== null && start >= sync.now + KEEP_MARGIN_MS && start < sync.now + IMPORT_HORIZON_MS;
  if (source.event_id !== null && !waiting) return;
  sync.statements.push(
    sync.env.DB.prepare("DELETE FROM stream_event_sources WHERE streamer_id=? AND platform=? AND external_id=?").bind(
      sync.streamerId,
      sync.platform,
      source.external_id,
    ),
  );
  if (source.event_id === null) return;
  sync.changed = true;
  sync.statements.push(...unlinked(sync.env, source.event_id, sync.platform));
}

/**
 * Writes one platform's read into the page's schedule in one batch. Returns whether an entry changed. The import
 * changes only entries it created and the owner did not edit; an entry that the owner created or edited only gains
 * or loses a link.
 */
export async function syncPlatform(
  env: AppEnv,
  streamerId: string,
  platform: ImportPlatform,
  streams: ImportedStream[],
  now: number,
): Promise<boolean> {
  const sync = await startSync(env, streamerId, platform, now);
  const read = new Set<string>();
  for (const stream of streams) {
    if (read.has(stream.externalId)) continue;
    read.add(stream.externalId);
    const source = sync.known.get(stream.externalId);
    if (source) readAgain(sync, source, stream);
    else readNew(sync, stream);
  }
  for (const source of sync.known.values()) if (!read.has(source.external_id)) notRead(sync, source);
  if (sync.statements.length === 0) return false;
  // The room was counted before the batch: the guard rolls the batch back when a parallel write filled the page.
  try {
    await env.DB.batch(sync.adds ? [...sync.statements, capacityGuard(env, streamerId, now)] : sync.statements);
  } catch (error: unknown) {
    if (!isCapacityError(error)) throw error;
    console.warn("schedule_import_full", { platform });
    return false;
  }
  return sync.changed;
}

/**
 * After a source of an imported entry left: the entry goes when it has no source left. Otherwise an entry of that
 * platform takes the platform and address of a remaining source.
 */
function unlinked(env: AppEnv, eventId: string, platform: ImportPlatform): D1PreparedStatement[] {
  return [
    env.DB.prepare(`DELETE FROM stream_events WHERE id=?1 AND imported=1
      AND NOT EXISTS(SELECT 1 FROM stream_event_sources WHERE event_id=?1)`).bind(eventId),
    env.DB.prepare(`UPDATE stream_events SET
        platform=(SELECT platform FROM stream_event_sources WHERE event_id=?1 ORDER BY platform LIMIT 1),
        url=(SELECT url FROM stream_event_sources WHERE event_id=?1 ORDER BY platform LIMIT 1)
      WHERE id=?1 AND imported=1 AND platform=?2`).bind(eventId, platform),
  ];
}

/** The platforms of the page with a connection that the import can read. */
async function readablePlatforms(env: AppEnv, streamerId: string): Promise<ImportPlatform[]> {
  const { results } = await env.DB.prepare(
    `SELECT platform FROM channel_connections WHERE streamer_id=? AND platform IN ('twitch','youtube')
      AND status <> 'needs_reauth' AND (status_code IS NULL OR status_code <> 'disconnecting')`,
  )
    .bind(streamerId)
    .all<{ platform: ImportPlatform }>();
  return IMPORT_PLATFORMS.filter((platform: ImportPlatform): boolean =>
    results.some((row: { platform: ImportPlatform }): boolean => row.platform === platform),
  );
}

/** Reads the scheduled streams of each connected channel of the page. A failed read changes nothing. */
export async function importPageSchedule(env: AppEnv, streamerId: string, now: number): Promise<void> {
  let changed = false;
  for (const platform of await readablePlatforms(env, streamerId)) {
    const streams = await readStreams(env, streamerId, platform, now);
    if (streams === null) continue;
    if (await syncPlatform(env, streamerId, platform, streams, now)) changed = true;
  }
  if (changed) await refreshPageOverlay(env, streamerId, ["next"]);
}

/** Marks the page as read now when its last read is older than `interval`. Returns whether this call may read. */
async function claim(env: AppEnv, streamerId: string, now: number, interval: number): Promise<boolean> {
  const row = await env.DB.prepare(`INSERT INTO schedule_imports (streamer_id, read_at) VALUES (?1, ?2)
      ON CONFLICT(streamer_id) DO UPDATE SET read_at=excluded.read_at WHERE schedule_imports.read_at <= ?3
      RETURNING read_at`)
    .bind(streamerId, now, now - interval)
    .first<{ read_at: number }>();
  return row !== null;
}

/** Whether the deployment can read channels: the test deployment uses `testStreams` instead. */
function importAvailable(env: AppEnv): boolean {
  return env.APP_ENV === "test" || activityAvailable(env);
}

/** The owner opened the schedule: read the channels after the response, at most each 10 minutes. */
export function importAfterVisit(env: AppEnv, streamerId: string): void {
  waitUntil(importOnVisit(env, streamerId));
}

export async function importOnVisit(env: AppEnv, streamerId: string, now: number = Date.now()): Promise<void> {
  if (!importAvailable(env) || (await readablePlatforms(env, streamerId)).length === 0) return;
  if (!(await claim(env, streamerId, now, OWNER_READ_INTERVAL_MS))) return;
  try {
    await importPageSchedule(env, streamerId, now);
  } catch (error: unknown) {
    logError("schedule_import_failed", error);
  }
}

/**
 * Hourly: reads the pages with a connected Twitch or YouTube channel whose last read is the oldest, each at most
 * once in 6 hours. Deletes YouTube sources that no read found for 30 days, with the imported entries that only they
 * held, and links without an entry after the same time.
 */
export async function importSchedules(env: AppEnv, now: number): Promise<number> {
  const stale = now - SOURCE_RETENTION_MS;
  await env.DB.batch([
    // An imported entry with an expired YouTube link and another source takes the link of that source.
    env.DB.prepare(`UPDATE stream_events SET
        platform=(SELECT platform FROM stream_event_sources s WHERE s.event_id=stream_events.id AND s.platform <> 'youtube'
          ORDER BY s.platform LIMIT 1),
        url=(SELECT url FROM stream_event_sources s WHERE s.event_id=stream_events.id AND s.platform <> 'youtube'
          ORDER BY s.platform LIMIT 1)
      WHERE imported=1 AND platform='youtube' AND id IN (SELECT event_id FROM stream_event_sources
          WHERE platform='youtube' AND read_at < ?1 AND event_id IS NOT NULL)
        AND EXISTS(SELECT 1 FROM stream_event_sources s WHERE s.event_id=stream_events.id AND s.platform <> 'youtube')`).bind(
      stale,
    ),
    // YouTube data must not stay longer than 30 days without a new read: the entries that only it holds go too.
    // An entry that a Twitch source also holds stays, without its YouTube link.
    env.DB.prepare(`DELETE FROM stream_events WHERE imported=1 AND id IN (SELECT event_id FROM stream_event_sources
        WHERE platform='youtube' AND read_at < ?1 AND event_id IS NOT NULL)
      AND NOT EXISTS(SELECT 1 FROM stream_event_sources s WHERE s.event_id=stream_events.id
        AND (s.read_at >= ?1 OR s.platform <> 'youtube'))`).bind(stale),
    // Twitch links of past streams stay with their entry; links without an entry go.
    env.DB.prepare(
      "DELETE FROM stream_event_sources WHERE read_at < ? AND (platform='youtube' OR event_id IS NULL)",
    ).bind(stale),
  ]);
  if (!importAvailable(env)) return 0;
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT c.streamer_id FROM channel_connections c LEFT JOIN schedule_imports i ON i.streamer_id=c.streamer_id
      WHERE c.platform IN ('twitch','youtube') AND c.status <> 'needs_reauth'
        AND (c.status_code IS NULL OR c.status_code <> 'disconnecting') AND (i.read_at IS NULL OR i.read_at <= ?)
      ORDER BY coalesce(i.read_at, 0), c.streamer_id LIMIT ?`,
  )
    .bind(now - CRON_READ_INTERVAL_MS, CRON_PAGES)
    .all<{ streamer_id: string }>();
  let read = 0;
  for (const { streamer_id: streamerId } of results) {
    if (!(await claim(env, streamerId, now, CRON_READ_INTERVAL_MS))) continue;
    try {
      await importPageSchedule(env, streamerId, now);
      read += 1;
    } catch (error: unknown) {
      logError("schedule_import_failed", error);
    }
  }
  return read;
}
