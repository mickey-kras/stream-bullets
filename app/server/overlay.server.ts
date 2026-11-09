import { z } from "zod";
import { OVERLAY_MESSAGE_STYLES, OVERLAY_POSITIONS, OVERLAY_SIZES } from "../../db/enums";
import type { AppEnv } from "../env";
import type { CardIcon, OverlayData, OverlaySource, OverlaySourceRef, OverlayState, SupportLinkKind } from "../types";
import { assertStreamerWritable } from "./access.server";
import { HttpError } from "./http.server";
import { notifyOverlay } from "./live.server";
import {
  OVERLAY_COLUMNS,
  OVERLAY_MESSAGE_LENGTH,
  overlaySourceSchema,
  overlayValue,
  type OverlayRow,
} from "./overlay-state";

/** Overlay control (item 33): one OBS URL per page, and the owner switches what it shows. */

/** `POST /api/overlay`. Every action returns the whole new state. */
export const overlayActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("preview"), source: overlaySourceSchema }).strict(),
  z.object({ action: z.literal("take") }).strict(),
  z
    .object({
      action: z.literal("layout"),
      position: z.enum(OVERLAY_POSITIONS).optional(),
      size: z.enum(OVERLAY_SIZES).optional(),
      instant: z.boolean().optional(),
      showResults: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("message"),
      text: z
        .string()
        .trim()
        .max(OVERLAY_MESSAGE_LENGTH)
        .regex(/^[^\p{Cc}]*$/u, "Use a single line."),
      style: z.enum(OVERLAY_MESSAGE_STYLES),
    })
    .strict(),
]);
export type OverlayAction = z.infer<typeof overlayActionSchema>;

const LIST_LIMIT = 50;

export async function getOverlayState(env: AppEnv, streamerId: string): Promise<OverlayState> {
  const row = await env.DB.prepare(`SELECT ${OVERLAY_COLUMNS} FROM overlay_state WHERE streamer_id=?`)
    .bind(streamerId)
    .first<OverlayRow>();
  return overlayValue(row);
}

/** Checks that `ref` names something on this page, and drops refs the source does not use. */
async function checkedSource(env: AppEnv, streamerId: string, source: OverlaySourceRef): Promise<OverlaySourceRef> {
  if (source.type === "poll" || source.type === "topic") {
    if (source.ref === null) throw new HttpError(400, "Pick a poll or topic.");
    const found = await env.DB.prepare(
      `SELECT 1 FROM entries WHERE id=? AND streamer_id=? AND kind ${source.type === "topic" ? "=" : "!="} 'topic'`,
    )
      .bind(source.ref, streamerId)
      .first();
    if (!found) throw new HttpError(404, source.type === "topic" ? "Topic not found." : "Poll not found.");
    return source;
  }
  if (source.type === "card" && source.ref !== null) {
    const found = await env.DB.prepare("SELECT 1 FROM community_cards WHERE id=? AND streamer_id=?")
      .bind(source.ref, streamerId)
      .first();
    if (!found) throw new HttpError(404, "Community card not found.");
    return source;
  }
  return { type: source.type, ref: null };
}

/** The state after an action. Pure apart from the source check, so the rules read in one place. */
export async function nextOverlayState(
  env: AppEnv,
  streamerId: string,
  current: OverlayState,
  action: OverlayAction,
): Promise<OverlayState> {
  const next: OverlayState = { ...current, revision: current.revision + 1 };
  if (action.action === "preview") next.preview = await checkedSource(env, streamerId, action.source);
  if (action.action === "take") next.air = current.preview;
  if (action.action === "layout") {
    next.position = action.position ?? current.position;
    next.size = action.size ?? current.size;
    next.instant = action.instant ?? current.instant;
    next.showResults = action.showResults ?? current.showResults;
  }
  if (action.action === "message") {
    next.message = action.text;
    next.messageStyle = action.style;
  }
  // Instant switch skips the preview: whatever is previewed is on air.
  if (next.instant) next.air = next.preview;
  return next;
}

/**
 * After a change to what some sources show (the schedule for Up next, the links for Support): an overlay with one of
 * `sources` on air or in preview gets a new revision and the live room is told, so the OBS page reloads its data.
 * Other sources are left alone.
 */
export async function refreshOverlayFor(
  env: AppEnv,
  ownerId: string,
  sources: readonly OverlaySource[],
): Promise<void> {
  await refreshWhere(env, "(SELECT id FROM streamers WHERE owner_id=?2)", ownerId, sources);
}

/** `refreshOverlayFor` by page id, for writes with no owner request behind them (the cron's series top-up). */
export async function refreshPageOverlay(
  env: AppEnv,
  streamerId: string,
  sources: readonly OverlaySource[],
): Promise<void> {
  await refreshWhere(env, "?2", streamerId, sources);
}

async function refreshWhere(
  env: AppEnv,
  page: "?2" | "(SELECT id FROM streamers WHERE owner_id=?2)",
  key: string,
  sources: readonly OverlaySource[],
): Promise<void> {
  const row = await env.DB.prepare(`UPDATE overlay_state SET revision=revision+1, updated_at=?1
    WHERE streamer_id=${page}
      AND (json_extract(air,'$.type') IN (SELECT value FROM json_each(?3))
        OR json_extract(preview,'$.type') IN (SELECT value FROM json_each(?3)))
    RETURNING streamer_id`)
    .bind(Date.now(), key, JSON.stringify(sources))
    .first<{ streamer_id: string }>();
  if (row) await notifyOverlay(env, row.streamer_id);
}

/** How many times an action is re-applied when another control tab saved in between. */
const OVERLAY_WRITE_ATTEMPTS = 3;

/**
 * Applies an owner action and stores the result. The write only lands on the revision the action was applied to,
 * so two control tabs never overwrite each other: on a lost race the action is applied again to the newer state.
 * The caller then tells the live room (`notifyOverlay`).
 */
export async function updateOverlay(
  env: AppEnv,
  userId: string,
  streamerId: string,
  action: OverlayAction,
): Promise<OverlayState> {
  const page = await assertStreamerWritable(env, streamerId, userId);
  if (page.ownerId !== userId) throw new HttpError(403, "Only the streamer can control the overlay.");
  for (let attempt = 0; attempt < OVERLAY_WRITE_ATTEMPTS; attempt++) {
    const current = await getOverlayState(env, streamerId);
    const next = await nextOverlayState(env, streamerId, current, action);
    const result = await env.DB.prepare(`INSERT INTO overlay_state (streamer_id,air,preview,position,size,instant,
        show_results,message,message_style,revision,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(streamer_id) DO UPDATE SET air=excluded.air,preview=excluded.preview,position=excluded.position,
        size=excluded.size,instant=excluded.instant,show_results=excluded.show_results,message=excluded.message,
        message_style=excluded.message_style,revision=excluded.revision,updated_at=excluded.updated_at
      WHERE overlay_state.revision=?`)
      .bind(
        streamerId,
        JSON.stringify(next.air),
        JSON.stringify(next.preview),
        next.position,
        next.size,
        next.instant ? 1 : 0,
        next.showResults ? 1 : 0,
        next.message,
        next.messageStyle,
        next.revision,
        Date.now(),
        current.revision,
      )
      .run();
    if (result.meta.changes > 0) return next;
  }
  throw new HttpError(409, "The overlay changed in another tab. Try again.");
}

interface TopicRow {
  id: string;
  title: string;
  category: string;
  author_id: string;
  author: string;
  image: string | null;
  avatar_preset: number | null;
  likes: number;
}

interface CardRow {
  id: string;
  icon: CardIcon | null;
  title: string;
  body: string;
  button_label: string | null;
  button_target: string | null;
}

/** The topics `sources` show, so `getOverlayData` has them even when they are older than the newest 50. */
export function sourceTopics(...sources: OverlaySourceRef[]): string[] {
  return sources.flatMap((source: OverlaySourceRef): string[] =>
    source.type === "topic" && source.ref !== null ? [source.ref] : [],
  );
}

/**
 * What the topic, Up next, Community card and Support sources show. `topicIds` (from `sourceTopics`) makes sure the
 * topics on air and in preview resolve even when they are older than the newest 50.
 */
export async function getOverlayData(
  env: AppEnv,
  streamerId: string,
  topicIds: readonly string[],
): Promise<OverlayData> {
  const [polls, topics, cards, next, support] = await env.DB.batch([
    env.DB.prepare(`SELECT e.id,e.title,EXISTS(SELECT 1 FROM entry_mash m WHERE m.entry_id=e.id) AS mash FROM entries e
      WHERE e.streamer_id=? AND e.kind!='topic' ORDER BY e.created_at DESC,e.id DESC LIMIT ${LIST_LIMIT}`).bind(
      streamerId,
    ),
    env.DB.prepare(`SELECT e.id,e.title,e.category,e.author_id,u.name AS author,u.image,u.avatar_preset,
        (SELECT count(*) FROM entry_reactions r WHERE r.entry_id=e.id AND r.value=1) AS likes
      FROM entries e JOIN user u ON u.id=e.author_id
      WHERE e.streamer_id=? AND e.kind='topic' AND (e.id IN (SELECT id FROM entries WHERE streamer_id=? AND kind='topic'
        ORDER BY created_at DESC LIMIT ${LIST_LIMIT}) OR e.id IN (SELECT value FROM json_each(?)))
      ORDER BY e.created_at DESC`).bind(streamerId, streamerId, JSON.stringify(topicIds)),
    env.DB.prepare(
      "SELECT id,icon,title,body,button_label,button_target FROM community_cards WHERE streamer_id=? ORDER BY position",
    ).bind(streamerId),
    env.DB.prepare(`SELECT title,starts_at FROM stream_events WHERE streamer_id=? AND status='scheduled' AND starts_at>?
      ORDER BY starts_at LIMIT 1`).bind(streamerId, Date.now()),
    env.DB.prepare("SELECT kind,label,url FROM streamer_links WHERE streamer_id=? ORDER BY position LIMIT 1").bind(
      streamerId,
    ),
  ]);
  const event = next.results[0] as { title: string; starts_at: number } | undefined;
  const link = support.results[0] as { kind: SupportLinkKind; label: string | null; url: string } | undefined;
  return {
    polls: (polls.results as { id: string; title: string; mash: number }[]).map((row) => ({
      id: row.id,
      title: row.title,
      mash: row.mash === 1,
    })),
    topics: (topics.results as TopicRow[]).map((row: TopicRow) => ({
      id: row.id,
      title: row.title,
      category: row.category,
      author: row.author,
      avatar: row.image === `/images/avatar/${encodeURIComponent(row.author_id)}` ? row.image : null,
      avatarPreset: row.avatar_preset,
      likes: row.likes,
    })),
    cards: (cards.results as CardRow[]).map((row: CardRow) => ({
      id: row.id,
      icon: row.icon,
      title: row.title,
      body: row.body,
      label: row.button_label,
      target: row.button_target,
    })),
    next: event ? { title: event.title, startsAt: event.starts_at } : null,
    support: link ?? null,
  };
}
