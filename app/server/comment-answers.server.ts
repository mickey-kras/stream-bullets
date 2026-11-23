import { z } from "zod";
import { STREAM_PLATFORMS } from "../../db/enums";
import type { AppEnv } from "../env";
import type { Locale } from "../i18n";
import type { AnsweredStream, Comment, CommentAnswer, StreamPlatform } from "../types";
import { assertStreamerWritable } from "./access.server";
import { twitchLiveStream } from "./channel-providers.server";
import { activityAvailable } from "./channel-tokens.server";
import { consumeMutationQuota, parsed } from "./data.server";
import { HttpError } from "./http.server";
import { attachEventTitleTranslations } from "./page-translation.server";

// The "Answered" mark of a comment (#984). Only the owner of the page of the comment sets, changes or removes it.

/** The time code is this many seconds before the mark, unless the page owner chose another lead. */
export const DEFAULT_ANSWER_LEAD_S = 300;
/** The largest time code and lead: a stream is shorter than 48 hours, and the owner answers within an hour. */
export const MAX_ANSWER_OFFSET_S = 172_800;
export const MAX_ANSWER_LEAD_S = 3600;

export const answerActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("mark") }).strict(),
  z.object({ action: z.literal("unmark") }).strict(),
  z.object({ action: z.literal("offset"), offsetSeconds: z.number().int().min(0).max(MAX_ANSWER_OFFSET_S) }).strict(),
]);
export type AnswerAction = z.infer<typeof answerActionSchema>;

export const answerLeadSchema = z
  .object({
    leadMinutes: z
      .number()
      .int()
      .min(0)
      .max(MAX_ANSWER_LEAD_S / 60),
  })
  .strict();

/** The SQL column of `entry_comments c` that holds its mark as JSON, or null. */
export const ANSWER_COLUMN = `(SELECT json_object('markedAt',a.marked_at,'platform',a.platform,'url',a.url,
        'title',coalesce(ev.title,a.title),'startedAt',a.started_at,'offset',a.offset_s,'eventId',a.event_id)
      FROM comment_answers a LEFT JOIN stream_events ev ON ev.id=a.event_id WHERE a.comment_id=c.id) AS answer`;

const storedAnswer = z.object({
  markedAt: z.number(),
  platform: z.enum(STREAM_PLATFORMS).nullable(),
  url: z.string().nullable(),
  title: z.string().nullable(),
  startedAt: z.number().nullable(),
  offset: z.number().nullable(),
  eventId: z.string().nullable(),
});

// The scheduled stream of each shown mark, so its title can take the stored translation of that stream.
const eventOf = new WeakMap<AnsweredStream, string>();

function twitchTime(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours}h${minutes}m${seconds % 60}s`;
}

/**
 * The address of the stream at `offset` seconds. Only addresses that accept a time code get one: a YouTube
 * video (`t=<seconds>s`) and a Twitch VOD (`t=1h2m3s`). Any other address, also a Twitch channel, stays as it is.
 */
export function answerLink(url: string, offset: number): string {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return url;
  }
  if (parsedUrl.protocol !== "https:") return url;
  const host = parsedUrl.hostname.replace(/^(www|m)\./, "");
  const youtubeVideo =
    (host === "youtube.com" && (parsedUrl.pathname === "/watch" || /^\/live\/[\w-]+$/.test(parsedUrl.pathname))) ||
    (host === "youtu.be" && /^\/[\w-]+$/.test(parsedUrl.pathname));
  if (youtubeVideo) parsedUrl.searchParams.set("t", `${offset}s`);
  else if (host === "twitch.tv" && /^\/videos\/\d+$/.test(parsedUrl.pathname))
    parsedUrl.searchParams.set("t", twitchTime(offset));
  else return url;
  return parsedUrl.toString();
}

/** The mark of a comment from its `ANSWER_COLUMN` JSON. */
export function answerValue(json: string): CommentAnswer {
  const row = storedAnswer.parse(JSON.parse(json));
  if (row.platform === null || row.url === null || row.startedAt === null || row.offset === null)
    return { markedAt: row.markedAt, stream: null };
  const stream: AnsweredStream = {
    platform: row.platform,
    title: row.title ?? "",
    startedAt: row.startedAt,
    offsetSeconds: row.offset,
    link: answerLink(row.url, row.offset),
  };
  if (row.eventId) eventOf.set(stream, row.eventId);
  return { markedAt: row.markedAt, stream };
}

interface LiveSource {
  platform: StreamPlatform;
  url: string;
  title: string;
  startedAt: number;
  eventId: string | null;
}

// The scheduled stream of the page that is live now (`effectiveStatus`), newest start first.
async function liveEvent(
  env: AppEnv,
  streamerId: string,
  now: number,
): Promise<{ id: string; title: string; platform: StreamPlatform; url: string; starts_at: number } | null> {
  return env.DB.prepare(
    `SELECT id,title,platform,url,starts_at FROM stream_events WHERE streamer_id=?1 AND status IN ('scheduled','live')
      AND (status='live' OR starts_at <= ?2) AND ?2 < starts_at + duration_min*60000 ORDER BY starts_at DESC, id LIMIT 1`,
  )
    .bind(streamerId, now)
    .first();
}

// The live Twitch stream of the page's connected channel. The test deployment reads no platform; a failed read
// counts as offline, so the mark falls back to the schedule.
async function liveTwitch(env: AppEnv, streamerId: string): Promise<Awaited<ReturnType<typeof twitchLiveStream>>> {
  if (env.APP_ENV === "test" || !activityAvailable(env)) return null;
  const connection = await env.DB.prepare(
    "SELECT external_id FROM channel_connections WHERE streamer_id=? AND platform='twitch' AND status <> 'needs_reauth'",
  )
    .bind(streamerId)
    .first<{ external_id: string }>();
  if (!connection) return null;
  try {
    return await twitchLiveStream(env, connection.external_id);
  } catch (error: unknown) {
    console.warn("answer_live_read_failed", {
      platform: "twitch",
      cause: error instanceof Error ? error.name : "unknown",
    });
    return null;
  }
}

/**
 * The stream that is live on the page now: the connected Twitch channel, else a scheduled stream with the status
 * "live". A live Twitch stream takes the title of the live scheduled stream, which has translations.
 */
export async function liveSource(env: AppEnv, streamerId: string, now: number): Promise<LiveSource | null> {
  const [twitch, event] = await Promise.all([liveTwitch(env, streamerId), liveEvent(env, streamerId, now)]);
  if (twitch)
    return {
      platform: "twitch",
      url: twitch.url,
      title: event?.title ?? twitch.title,
      startedAt: twitch.startedAt,
      eventId: event?.id ?? null,
    };
  if (!event) return null;
  return {
    platform: event.platform,
    url: event.url,
    title: event.title,
    startedAt: Math.min(event.starts_at, now),
    eventId: event.id,
  };
}

/** The time code of a mark: `lead` seconds before the mark, never before the start of the stream. */
export function answerOffset(markedAt: number, startedAt: number, lead: number): number {
  return Math.min(MAX_ANSWER_OFFSET_S, Math.max(0, Math.floor((markedAt - startedAt) / 1000) - lead));
}

async function answerLead(env: AppEnv, streamerId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT lead_s FROM answer_settings WHERE streamer_id=?")
    .bind(streamerId)
    .first<{ lead_s: number }>();
  return row?.lead_s ?? DEFAULT_ANSWER_LEAD_S;
}

// The page of a comment that the viewer owns. Everyone else gets the 404 of a missing comment.
async function ownedComment(env: AppEnv, viewerId: string, id: string): Promise<{ streamer_id: string }> {
  const row = await env.DB.prepare(
    `SELECT e.streamer_id,s.owner_id FROM entry_comments c JOIN entries e ON e.id=c.entry_id
      JOIN streamers s ON s.id=e.streamer_id WHERE c.id=? AND c.removed_at IS NULL`,
  )
    .bind(id)
    .first<{ streamer_id: string; owner_id: string }>();
  if (row?.owner_id !== viewerId) throw new HttpError(404, "Comment not found.");
  return row;
}

async function readAnswer(env: AppEnv, id: string): Promise<CommentAnswer | null> {
  const row = await env.DB.prepare(`SELECT ${ANSWER_COLUMN} FROM entry_comments c WHERE c.id=?`)
    .bind(id)
    .first<{ answer: string | null }>();
  return row?.answer ? answerValue(row.answer) : null;
}

async function markComment(env: AppEnv, viewerId: string, id: string, streamerId: string, now: number): Promise<void> {
  const [live, lead] = await Promise.all([liveSource(env, streamerId, now), answerLead(env, streamerId)]);
  // The guard in the statement keeps a comment removed during the read without a mark.
  await env.DB.prepare(
    `INSERT INTO comment_answers (comment_id,streamer_id,marked_at,marked_by,platform,url,title,event_id,started_at,offset_s)
      SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10 WHERE EXISTS(SELECT 1 FROM entry_comments WHERE id=?1 AND removed_at IS NULL)
      ON CONFLICT(comment_id) DO UPDATE SET marked_at=excluded.marked_at, marked_by=excluded.marked_by,
        platform=excluded.platform, url=excluded.url, title=excluded.title, event_id=excluded.event_id,
        started_at=excluded.started_at, offset_s=excluded.offset_s`,
  )
    .bind(
      id,
      streamerId,
      now,
      viewerId,
      live?.platform ?? null,
      live?.url ?? null,
      live ? live.title.slice(0, 100) : null,
      live?.eventId ?? null,
      live?.startedAt ?? null,
      live ? answerOffset(now, live.startedAt, lead) : null,
    )
    .run();
}

/**
 * Sets, changes or removes the mark of a comment. The owner of its page only; a removed comment has no mark.
 * Returns the mark, or null after "unmark".
 */
export async function answerComment(
  env: AppEnv,
  viewerId: string,
  id: string,
  input: unknown,
  now: number = Date.now(),
): Promise<CommentAnswer | null> {
  const action: AnswerAction = parsed(answerActionSchema, input);
  const comment = await ownedComment(env, viewerId, id);
  await assertStreamerWritable(env, comment.streamer_id, viewerId);
  await consumeMutationQuota(env, viewerId);
  if (action.action === "unmark") {
    await env.DB.prepare("DELETE FROM comment_answers WHERE comment_id=?").bind(id).run();
    return null;
  }
  if (action.action === "mark") await markComment(env, viewerId, id, comment.streamer_id, now);
  else {
    const result = await env.DB.prepare(
      "UPDATE comment_answers SET offset_s=? WHERE comment_id=? AND started_at IS NOT NULL",
    )
      .bind(action.offsetSeconds, id)
      .run();
    if (result.meta.changes === 0) throw new HttpError(409, "This mark has no stream.");
  }
  const answer = await readAnswer(env, id);
  if (!answer) throw new HttpError(404, "Comment not found.");
  return answer;
}

async function ownPage(env: AppEnv, viewerId: string): Promise<string> {
  const page = await env.DB.prepare("SELECT id FROM streamers WHERE owner_id=?").bind(viewerId).first<{ id: string }>();
  if (!page) throw new HttpError(404, "Create your streamer page first.");
  return page.id;
}

/** Saves the lead of the time code of the viewer's page, in minutes. */
export async function setAnswerLead(env: AppEnv, viewerId: string, input: unknown): Promise<{ leadMinutes: number }> {
  const { leadMinutes } = parsed(answerLeadSchema, input);
  const pageId = await ownPage(env, viewerId);
  await assertStreamerWritable(env, pageId, viewerId);
  await consumeMutationQuota(env, viewerId);
  await env.DB.prepare(
    "INSERT INTO answer_settings (streamer_id,lead_s) VALUES (?,?) ON CONFLICT(streamer_id) DO UPDATE SET lead_s=excluded.lead_s",
  )
    .bind(pageId, leadMinutes * 60)
    .run();
  return { leadMinutes };
}

/** The lead of the time code of the viewer's page, in minutes. */
export async function answerLeadMinutes(env: AppEnv, viewerId: string): Promise<number> {
  return Math.round((await answerLead(env, await ownPage(env, viewerId))) / 60);
}

/** Puts the stored translation for `locale` on the title of each mark that names a scheduled stream. */
export async function attachAnswerTranslations(
  env: AppEnv,
  comments: readonly Comment[],
  locale: Locale,
  keep: readonly Locale[],
): Promise<void> {
  await translateAnswers(
    env,
    comments.map((comment: Comment) => comment.answer),
    locale,
    keep,
  );
}

/** The same for marks without their comments, such as the answer of a mark request. */
export async function translateAnswers(
  env: AppEnv,
  answers: readonly (CommentAnswer | null | undefined)[],
  locale: Locale,
  keep: readonly Locale[],
): Promise<void> {
  const streams = answers
    .map((answer): AnsweredStream | null | undefined => answer?.stream)
    .filter((stream): stream is AnsweredStream => Boolean(stream && eventOf.has(stream)));
  if (streams.length === 0) return;
  await attachEventTitleTranslations(
    env,
    streams.map((stream: AnsweredStream) => ({
      eventId: eventOf.get(stream) ?? "",
      apply: (title: string | null): void => {
        stream.titleTranslation = title;
      },
    })),
    locale,
    keep,
  );
}
