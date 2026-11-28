import { z } from "zod";
import { OVERLAY_MESSAGE_STYLES } from "../../db/enums";
import type { AppEnv } from "../env";
import { CHAT_TEST_MS } from "../lib/chat-test";
import { legacyLayersText } from "../lib/overlay-legacy";
import {
  ORIENTATIONS,
  STORED_LAYERS_LENGTH,
  layersPatchSchema,
  mergeLayers,
  onAnyOutput,
  overlappingPair,
  storedLayersText,
  type ContentLayer,
  type ContentSource,
  type OverlayLayers,
} from "../lib/overlay-layers";
import { featuredTopic } from "../lib/topic-credit";
import type { CardIcon, OverlayData, OverlayState, SupportLinkKind } from "../types";
import { assertStreamerWritable } from "./access.server";
import { HttpError } from "./http.server";
import { notifyOverlay } from "./live.server";
import { byOwner, notHeld } from "./poll-sql";
import {
  OVERLAY_COLUMNS,
  OVERLAY_MESSAGE_LENGTH,
  overlayValue,
  placedLayerSql,
  type OverlayRow,
} from "./overlay-state";

// Owners control one OBS URL per page.

// An editor's random id and the number of its layer write. Numbers go up for each write of the editor.
const layersWriteSchema = z
  .object({
    writer: z.string().regex(/^[\w-]{8,64}$/),
    seq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
type LayersWrite = z.infer<typeof layersWriteSchema>;

// `POST /api/overlay`. Every action returns the whole new state.
export const overlayActionSchema = z.discriminatedUnion("action", [
  // Shows (`on`) or hides the results of the poll on the overlay.
  z.object({ action: z.literal("showResults"), on: z.boolean() }).strict(),
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
  // Layer edits go live at once. `write` orders the writes of one editor (see updateOverlay).
  layersPatchSchema.extend({ action: z.literal("layers"), write: layersWriteSchema.optional() }),
  // Starts (`on`) or stops the chat test. The overlay pages play sample chat until the stored end time.
  z.object({ action: z.literal("chatTest"), on: z.boolean() }).strict(),
]);
export type OverlayAction = z.infer<typeof overlayActionSchema>;

const LIST_LIMIT = 50;

// An old `layers` text reads as its converted layers (overlayValue). The first read here stores them, so the
// conversion happens once. The state does not change, so the revision stays. A save at the same time wins: it also
// stores the current version.
export async function getOverlayState(env: AppEnv, streamerId: string): Promise<OverlayState> {
  const row = await env.DB.prepare(`SELECT ${OVERLAY_COLUMNS} FROM overlay_state WHERE streamer_id=?`)
    .bind(streamerId)
    .first<OverlayRow>();
  const state: OverlayState = overlayValue(row);
  if (row && legacyLayersText(row.layers))
    await env.DB.prepare("UPDATE overlay_state SET layers=?1 WHERE streamer_id=?2 AND revision=?3 AND layers=?4")
      .bind(storedLayersText(state.layers), streamerId, row.revision, row.layers)
      .run();
  return state;
}

/** A poll or topic of this page. A poll that moderation holds is not selectable. */
async function checkedEntry(env: AppEnv, streamerId: string, type: "poll" | "topic", ref: string): Promise<void> {
  const topic: boolean = type === "topic";
  const kind: string = topic ? "= 'topic'" : `!= 'topic' AND ${notHeld()}`;
  const found = await env.DB.prepare(`SELECT 1 FROM entries WHERE id=? AND streamer_id=? AND kind ${kind}`)
    .bind(ref, streamerId)
    .first();
  if (!found) throw new HttpError(404, topic ? "Topic not found." : "Poll not found.");
}

async function checkedCard(env: AppEnv, streamerId: string, ref: string): Promise<void> {
  const found = await env.DB.prepare("SELECT 1 FROM community_cards WHERE id=? AND streamer_id=?")
    .bind(ref, streamerId)
    .first();
  if (!found) throw new HttpError(404, "Community card not found.");
}

type LayersAction = Extract<OverlayAction, { action: "layers" }>;

// A new ref of a content layer must name a poll, topic or card of this page.
async function checkItemRefs(env: AppEnv, streamerId: string, items: LayersAction["items"]): Promise<void> {
  for (const layer of ["poll", "topic"] as const) {
    const ref: string | null | undefined = items?.[layer]?.ref;
    if (typeof ref === "string") await checkedEntry(env, streamerId, layer, ref);
  }
  const card: string | null | undefined = items?.card?.ref;
  if (typeof card === "string") await checkedCard(env, streamerId, card);
}

// Merged layers must not overlap in either orientation: a patch can move a cell onto a saved cell. They must also
// fit the `layers` column.
async function mergedLayers(
  env: AppEnv,
  streamerId: string,
  current: OverlayLayers,
  patch: LayersAction,
): Promise<OverlayLayers> {
  const next: OverlayLayers = mergeLayers(current, patch);
  for (const orientation of ORIENTATIONS)
    if (overlappingPair(next.cells[orientation]) !== null) throw new HttpError(400, "Layers must not overlap.");
  if (storedLayersText(next).length > STORED_LAYERS_LENGTH)
    throw new HttpError(400, "The layers are too large to save. Take a layer off the grid.");
  await checkItemRefs(env, streamerId, patch.items);
  return next;
}

// The state after an action at server time `now`. Pure apart from the ref check, so the rules read in one place.
export async function nextOverlayState(
  env: AppEnv,
  streamerId: string,
  current: OverlayState,
  action: OverlayAction,
  now: number = Date.now(),
): Promise<OverlayState> {
  const next: OverlayState = { ...current, revision: current.revision + 1 };
  if (action.action === "showResults") next.showResults = action.on;
  if (action.action === "message") {
    next.message = action.text;
    next.messageStyle = action.style;
  }
  if (action.action === "layers") next.layers = await mergedLayers(env, streamerId, current.layers, action);
  // The test plays in the chat layer, so taking the layer off stream also ends a running test.
  if (!onAnyOutput(next.layers, "chat")) next.chatTestUntil = 0;
  if (action.action === "chatTest") {
    // The test cannot start while the chat layer is off stream. Stop always works.
    if (action.on && !onAnyOutput(current.layers, "chat"))
      throw new HttpError(400, "Put the chat layer on stream first.");
    next.chatTestUntil = action.on ? now + CHAT_TEST_MS : 0;
  }
  return next;
}

// When source data changes, bump overlays that have a content layer of that source on the grid in the selected
// orientation, and notify the room. Leave other overlays unchanged.
export async function refreshOverlayFor(env: AppEnv, ownerId: string, sources: readonly ContentLayer[]): Promise<void> {
  await refreshWhere(env, "(SELECT id FROM streamers WHERE owner_id=?2)", ownerId, sources);
}

// Page-ID variant for background writes such as cron top-ups.
export async function refreshPageOverlay(
  env: AppEnv,
  streamerId: string,
  sources: readonly ContentLayer[],
): Promise<void> {
  await refreshWhere(env, "?2", streamerId, sources);
}

async function refreshWhere(
  env: AppEnv,
  page: "?2" | "(SELECT id FROM streamers WHERE owner_id=?2)",
  key: string,
  sources: readonly ContentLayer[],
): Promise<void> {
  const row = await env.DB.prepare(`UPDATE overlay_state SET revision=revision+1, updated_at=?1
    WHERE streamer_id=${page}
      AND EXISTS (SELECT 1 FROM json_each(?3) source WHERE ${placedLayerSql("source.value")})
    RETURNING streamer_id`)
    .bind(Date.now(), key, JSON.stringify(sources))
    .first<{ streamer_id: string }>();
  if (row) notifyOverlay(env, row.streamer_id);
}

// Retry limit for concurrent overlay saves.
const OVERLAY_WRITE_ATTEMPTS = 3;

// The number of editors whose last applied layer write the server keeps (`overlay_state.layers_writes`).
const WRITERS_KEPT = 8;

// The last applied layer write of each recent editor, as [writer, seq] pairs, the most recent editor first.
const layersWritesSchema = z.array(z.tuple([z.string().max(64), z.number().int().positive()])).max(WRITERS_KEPT);
type LayersWrites = z.infer<typeof layersWritesSchema>;

// The stored write order. A malformed value reads as no writes and is logged, so it never blocks overlay actions:
// the next layer write replaces it.
export function storedWrites(raw: string): LayersWrites {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    value = undefined;
  }
  const parsed = layersWritesSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  console.warn("overlay_layers_writes_invalid");
  return [];
}

// `writes` with `write` as the most recent entry. The oldest editor drops out after WRITERS_KEPT editors.
function recordWrite(writes: LayersWrites, write: LayersWrite): LayersWrites {
  const others: LayersWrites = writes.filter(([writer]: [string, number]): boolean => writer !== write.writer);
  const latest: [string, number] = [write.writer, write.seq];
  return [latest, ...others].slice(0, WRITERS_KEPT);
}

// True when the editor of `write` already has an applied write with the same or a larger number.
function passedWrite(writes: LayersWrites, write: LayersWrite): boolean {
  return writes.some(([writer, seq]: [string, number]): boolean => writer === write.writer && write.seq <= seq);
}

/**
 * The record of a feature of a topic (docs/stream-reports.md): one `stream_features` row, in the D1 batch of the
 * overlay write that put the topic on stream. The row goes in only when that write is the stored state now: the
 * new revision, with the time and the layers that it wrote. Thus a lost compare-and-set records nothing, also when
 * another write took the same revision. A topic that is gone or of another page records nothing. Two writes of the
 * same state at the same time record one row.
 */
export function featureRecord(
  env: AppEnv,
  streamerId: string,
  entryId: string,
  write: { revision: number; at: number; layers: string },
): D1PreparedStatement {
  const sql = `INSERT OR IGNORE INTO stream_features (streamer_id,entry_id,featured_at)
    SELECT ?1,?2,?3 WHERE EXISTS (SELECT 1 FROM entries WHERE id=?2 AND streamer_id=?1 AND kind='topic')
      AND EXISTS (SELECT 1 FROM overlay_state WHERE streamer_id=?1 AND revision=?4 AND updated_at=?3 AND layers=?5)`;
  return env.DB.prepare(sql).bind(streamerId, entryId, write.at, write.revision, write.layers);
}

/**
 * The result of `updateOverlay`. `changed` is false when the server ignored an old layer write. `featured` is the
 * topic that the change put on stream (`featuredTopic`), or null. The caller then credits its author.
 */
export interface OverlayUpdate {
  overlay: OverlayState;
  changed: boolean;
  featured: string | null;
}

// Compare-and-set the revision. On conflict, reapply the action to current state; callers then `notifyOverlay` if
// `changed`. A layer write that its editor already passed (a seq not above the last applied seq of that writer)
// changes nothing and returns the current state: a request that a slower network delivers late never overwrites the
// newer layers of the same editor, also when other editors saved in between.
export async function updateOverlay(
  env: AppEnv,
  userId: string,
  streamerId: string,
  action: OverlayAction,
): Promise<OverlayUpdate> {
  const page = await assertStreamerWritable(env, streamerId, userId);
  if (page.ownerId !== userId) throw new HttpError(403, "Only the streamer can control the overlay.");
  const write: LayersWrite | undefined = action.action === "layers" ? action.write : undefined;
  for (let attempt = 0; attempt < OVERLAY_WRITE_ATTEMPTS; attempt++) {
    const row = await env.DB.prepare(`SELECT ${OVERLAY_COLUMNS},layers_writes FROM overlay_state WHERE streamer_id=?`)
      .bind(streamerId)
      .first<OverlayRow & { layers_writes: string }>();
    const current = overlayValue(row);
    const writes: LayersWrites = storedWrites(row?.layers_writes ?? "[]");
    if (write && passedWrite(writes, write)) return { overlay: current, changed: false, featured: null };
    const next = await nextOverlayState(env, streamerId, current, action);
    const applied: LayersWrites = write ? recordWrite(writes, write) : writes;
    const featured: string | null = featuredTopic(current.layers, next.layers);
    const layersText: string = storedLayersText(next.layers);
    const now: number = Date.now();
    // The columns from before the overlay studio keep their values: `air`, `preview`, `position`, `size`, `instant`.
    const upsert: D1PreparedStatement = env.DB.prepare(`INSERT INTO overlay_state (streamer_id,show_results,message,
        message_style,layers,chat_test_until,layers_writes,revision,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(streamer_id) DO UPDATE SET show_results=excluded.show_results,message=excluded.message,
        message_style=excluded.message_style,layers=excluded.layers,chat_test_until=excluded.chat_test_until,
        layers_writes=excluded.layers_writes,revision=excluded.revision,updated_at=excluded.updated_at
      WHERE overlay_state.revision=?`).bind(
      streamerId,
      next.showResults ? 1 : 0,
      next.message,
      next.messageStyle,
      layersText,
      next.chatTestUntil,
      JSON.stringify(applied),
      next.revision,
      now,
      current.revision,
    );
    const record: D1PreparedStatement[] =
      featured === null
        ? []
        : [featureRecord(env, streamerId, featured, { revision: next.revision, at: now, layers: layersText })];
    const [result] = await env.DB.batch([upsert, ...record]);
    if (result.meta.changes > 0) return { overlay: next, changed: true, featured };
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

interface PollChoiceRow {
  id: string;
  title: string;
  mash: number;
  by_owner: number;
  author: string;
}

interface CardRow {
  id: string;
  icon: CardIcon | null;
  title: string;
  body: string;
  button_label: string | null;
  button_target: string | null;
}

// Include referenced topics older than the newest 50.
export function sourceTopics(sources: readonly ContentSource[]): string[] {
  return sources.flatMap((source: ContentSource): string[] =>
    source.type === "topic" && source.ref !== null ? [source.ref] : [],
  );
}

// Source data for topics, Up next, Community, and Support. Include `topicIds` even outside the newest 50.
export async function getOverlayData(
  env: AppEnv,
  streamerId: string,
  topicIds: readonly string[],
): Promise<OverlayData> {
  const [polls, topics, cards, next, support] = await env.DB.batch([
    // The newest polls of the page owner, then the newest polls of other people. Viewer polls cannot push the
    // owner's polls out of the list. Polls that moderation holds stay out.
    env.DB.prepare(`WITH p AS (SELECT e.id,e.title,e.created_at,e.author_id,(${byOwner("e")}) AS by_owner,
        EXISTS(SELECT 1 FROM entry_mash m WHERE m.entry_id=e.id) AS mash
        FROM entries e WHERE e.streamer_id=? AND e.kind!='topic' AND ${notHeld("e")})
      SELECT p.id,p.title,p.mash,p.by_owner,u.name AS author FROM p JOIN user u ON u.id=p.author_id
      WHERE p.id IN (SELECT id FROM p WHERE by_owner=1 ORDER BY created_at DESC,id DESC LIMIT ${LIST_LIMIT})
        OR p.id IN (SELECT id FROM p WHERE by_owner=0 ORDER BY created_at DESC,id DESC LIMIT ${LIST_LIMIT})
      ORDER BY p.by_owner DESC,p.created_at DESC,p.id DESC`).bind(streamerId),
    env.DB.prepare(`SELECT e.id,e.title,e.category,e.author_id,u.name AS author,u.image,u.avatar_preset,
        COALESCE(activity.likes,0) AS likes
      FROM entries e JOIN user u ON u.id=e.author_id
      LEFT JOIN entry_activity_counts activity ON activity.entry_id=e.id
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
    polls: (polls.results as PollChoiceRow[]).map((row: PollChoiceRow) => ({
      id: row.id,
      title: row.title,
      mash: row.mash === 1,
      author: row.author,
      byOwner: row.by_owner === 1,
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
