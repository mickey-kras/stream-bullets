import { eq, gt } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";
import { streamers, user } from "../../db/schema";
import type { AppEnv } from "../env";
import type {
  BoardSnapshot,
  Comment,
  DiscussionSnapshot,
  Entry,
  EntryKind,
  LiveSnapshot,
  Reaction,
  Streamer,
  StreamerDirectory,
} from "../types";
import { canCreateStreamer } from "./access.server";
import { HttpError } from "./http.server";
import {
  commentActionSchema,
  commentQuerySchema,
  entryActionSchema,
  entryQuerySchema,
  streamerSchema,
} from "./validation";
import type { CommentQuery, EntryAction, EntryQuery, StreamerInput } from "./validation";

const PAGE_SIZE = 50;
const COMMENT_PAGE_SIZE = 100;
const MAX_ENTRIES = 1000;
const MAX_COMMENTS = 10000;
const cursorSchema = z
  .object({
    scope: z.string(),
    sort: z.enum(["newest", "top"]),
    query: z.string(),
    score: z.number().int(),
    time: z.number().int().nonnegative(),
    id: z.string().uuid(),
  })
  .strict();
type Cursor = z.infer<typeof cursorSchema>;

interface EntryRow {
  id: string;
  streamer_id: string;
  author_id: string;
  kind: EntryKind;
  title: string;
  body: string;
  category: string;
  options: string;
  created_at: number;
  ends_at: number | null;
  revealed: number;
  author: string;
  avatar: string | null;
  likes: number;
  dislikes: number;
  comments: number;
  vote_counts: string;
  reaction: Reaction;
  my_vote: number | null;
  score: number;
}
interface CommentRow {
  id: string;
  entry_id: string;
  author_id: string;
  text: string;
  created_at: number;
  parent_id: string | null;
  author: string;
  avatar: string | null;
  likes: number;
  liked: number;
}
interface PermissionRow {
  id: string;
  streamer_id: string;
  author_id: string;
  owner_id: string;
  kind: EntryKind;
}

function parsed<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new HttpError(400, result.error.issues[0]?.message ?? "Invalid input.");
  return result.data;
}

function publicAvatar(id: string, value: string | null): string | null {
  return value === `/images/avatar/${encodeURIComponent(id)}` ? value : null;
}

function decodeCursor(value: string | null, scope: string, sort: "newest" | "top", query = ""): Cursor | null {
  if (!value) return null;
  let decoded: unknown;
  try {
    const bytes = Uint8Array.from(
      atob(value.replaceAll("-", "+").replaceAll("_", "/")),
      (character: string): number => character.codePointAt(0)!,
    );
    decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new HttpError(400, "Invalid page cursor.");
  }
  const cursor = parsed(cursorSchema, decoded);
  if (cursor.scope !== scope || cursor.sort !== sort || cursor.query !== query)
    throw new HttpError(400, "This page cursor belongs to another list.");
  return cursor;
}

function encodeCursor(cursor: Cursor): string {
  const bytes = new TextEncoder().encode(JSON.stringify(cursor));
  return btoa(Array.from(bytes, (byte: number): string => String.fromCodePoint(byte)).join(""))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function streamerValue(row: typeof streamers.$inferSelect): Streamer {
  return {
    id: row.id,
    ownerId: row.ownerId,
    handle: row.handle,
    name: row.name,
    about: row.about,
    avatar: publicAvatar(row.ownerId, row.avatar),
    background: row.background === `/images/background/${encodeURIComponent(row.ownerId)}` ? row.background : null,
  };
}

export async function listStreamers(env: AppEnv, cursor: string | null = null): Promise<StreamerDirectory> {
  const handle = cursor === null ? null : parsed(streamerSchema.shape.handle, cursor);
  const rows = await drizzle(env.DB)
    .select()
    .from(streamers)
    .where(handle === null ? undefined : gt(streamers.handle, handle))
    .orderBy(streamers.handle)
    .limit(PAGE_SIZE + 1);
  const page = rows.slice(0, PAGE_SIZE);
  return {
    streamers: page.map(streamerValue),
    nextCursor: rows.length > PAGE_SIZE ? (page.at(-1)?.handle ?? null) : null,
  };
}

export async function getStreamer(env: AppEnv, handle: string): Promise<Streamer | null> {
  if (!/^[a-z0-9_]{3,30}$/u.test(handle)) return null;
  const [row] = await drizzle(env.DB).select().from(streamers).where(eq(streamers.handle, handle)).limit(1);
  return row ? streamerValue(row) : null;
}

export async function getOwnStreamer(env: AppEnv, userId: string): Promise<Streamer | null> {
  const [row] = await drizzle(env.DB).select().from(streamers).where(eq(streamers.ownerId, userId)).limit(1);
  return row ? streamerValue(row) : null;
}

export async function consumeMutationQuota(env: AppEnv, userId: string, content = false): Promise<void> {
  const limit = content ? 6 : 60;
  const key = `${content ? "content" : "write"}:${userId}`;
  const result = await env.DB.prepare(`
    INSERT INTO app_rate_limits (key, count, window_start) VALUES (?, 1, CAST(strftime('%s','now') AS INTEGER)/60*60000)
    ON CONFLICT(key) DO UPDATE SET
      count = CASE WHEN app_rate_limits.window_start < excluded.window_start THEN 1 ELSE app_rate_limits.count + 1 END,
      window_start = excluded.window_start
    WHERE app_rate_limits.window_start < excluded.window_start OR app_rate_limits.count < ?
    RETURNING count
  `)
    .bind(key, limit)
    .first<{ count: number }>();
  if (!result) throw new HttpError(429, "Too many requests. Wait one minute and try again.");
}

export async function saveStreamer(env: AppEnv, userId: string, input: StreamerInput): Promise<Streamer> {
  const value = parsed(streamerSchema, input);
  await consumeMutationQuota(env, userId);
  const [account] = await drizzle(env.DB).select({ image: user.image }).from(user).where(eq(user.id, userId)).limit(1);
  if (!account) throw new HttpError(401, "Sign in to create a streamer profile.");
  if (!(await getOwnStreamer(env, userId)) && !(await canCreateStreamer(env, userId)))
    throw new HttpError(403, "Streamer profiles need approval. Join the streamer waitlist first.");
  const avatar = publicAvatar(userId, account.image);
  try {
    const [row] = await drizzle(env.DB)
      .insert(streamers)
      .values({ id: crypto.randomUUID(), ownerId: userId, ...value, avatar })
      .onConflictDoUpdate({
        target: streamers.ownerId,
        set: { ...value, avatar },
      })
      .returning();
    if (!row) throw new Error("Streamer profile was not saved.");
    return streamerValue(row);
  } catch (error: unknown) {
    let message = "";
    if (error instanceof Error) {
      const causeMessage = error.cause instanceof Error ? error.cause.message : "";
      message = `${error.message} ${causeMessage}`;
    }
    if (message.includes("UNIQUE constraint failed: streamers.handle"))
      throw new HttpError(409, "This handle is already in use.");
    throw error;
  }
}

const entrySelect = `
  SELECT e.*, u.name AS author, u.image AS avatar,
    (SELECT count(*) FROM entry_reactions r WHERE r.entry_id=e.id AND r.value=1) AS likes,
    (SELECT count(*) FROM entry_reactions r WHERE r.entry_id=e.id AND r.value=-1) AS dislikes,
    (SELECT count(*) FROM entry_comments c WHERE c.entry_id=e.id) AS comments,
    (SELECT json_group_array(json_object('choice',choice,'count',n)) FROM
      (SELECT choice,count(*) AS n FROM entry_votes v WHERE v.entry_id=e.id GROUP BY choice)) AS vote_counts,
    COALESCE((SELECT value FROM entry_reactions r WHERE r.entry_id=e.id AND r.user_id=?),0) AS reaction,
    (SELECT choice FROM entry_votes v WHERE v.entry_id=e.id AND v.user_id=?) AS my_vote,
    COALESCE((SELECT sum(value) FROM entry_reactions r WHERE r.entry_id=e.id),0) AS score
  FROM entries e JOIN user u ON u.id=e.author_id
`;

function entryValue(row: EntryRow): Entry {
  const options = z.array(z.string()).parse(JSON.parse(row.options));
  const grouped = z
    .array(z.object({ choice: z.number().int(), count: z.number().int().nonnegative() }))
    .parse(JSON.parse(row.vote_counts));
  const counts = options.map(
    (_option: string, index: number): number =>
      grouped.find((value: { choice: number; count: number }) => value.choice === index)?.count ?? 0,
  );
  return {
    id: row.id,
    streamerId: row.streamer_id,
    authorId: row.author_id,
    author: row.author,
    avatar: publicAvatar(row.author_id, row.avatar),
    kind: row.kind,
    title: row.title,
    body: row.body,
    category: row.category,
    createdAt: row.created_at,
    endsAt: row.ends_at,
    revealed: row.revealed === 1,
    options,
    counts: row.kind === "binary" && !row.revealed ? null : counts,
    total: counts.reduce((sum: number, count: number): number => sum + count, 0),
    likes: row.likes,
    dislikes: row.dislikes,
    comments: row.comments,
    reaction: row.reaction,
    myVote: row.my_vote,
  };
}

export async function getEntry(env: AppEnv, id: string, viewerId: string | null): Promise<Entry | null> {
  const row = await env.DB.prepare(`${entrySelect} WHERE e.id=?`)
    .bind(viewerId ?? "", viewerId ?? "", id)
    .first<EntryRow>();
  return row ? entryValue(row) : null;
}

export async function getOverlaySnapshot(
  env: AppEnv,
  streamerId: string,
  pollId: string | null,
): Promise<LiveSnapshot> {
  const selection =
    pollId === null
      ? `COALESCE(
    (SELECT id FROM entries WHERE streamer_id=? AND kind!='topic' AND revealed=0
      AND (ends_at IS NULL OR ends_at>CAST(strftime('%s','now') AS INTEGER)*1000+CAST(substr(strftime('%f','now'),4,3) AS INTEGER))
      ORDER BY created_at DESC,id DESC LIMIT 1),
    (SELECT id FROM entries WHERE streamer_id=? AND kind!='topic' ORDER BY created_at DESC,id DESC LIMIT 1)
  )`
      : "?";
  const parameters: string[] =
    pollId === null ? ["", "", streamerId, streamerId, streamerId] : ["", "", pollId, streamerId];
  const results = await env.DB.batch([
    env.DB.prepare("SELECT revision FROM streamers WHERE id=?").bind(streamerId),
    env.DB.prepare(`${entrySelect} WHERE e.id=${selection} AND e.streamer_id=? AND e.kind!='topic'`).bind(
      ...parameters,
    ),
  ]);
  const revision = (results[0]?.results[0] as { revision: number } | undefined)?.revision;
  if (revision === undefined) throw new HttpError(404, "Streamer not found.");
  const rows = results[1].results as unknown as EntryRow[];
  return {
    type: "snapshot",
    revision,
    serverNow: Date.now(),
    polls: rows.map((row: EntryRow): LiveSnapshot["polls"][number] => {
      const entry = entryValue(row);
      return {
        id: entry.id,
        title: entry.title,
        kind: entry.kind,
        options: entry.options,
        endsAt: entry.endsAt,
        revealed: entry.revealed,
        counts: entry.counts,
        total: entry.total,
      };
    }),
  };
}

export async function listEntries(
  env: AppEnv,
  streamer: Streamer,
  viewerId: string | null,
  input: EntryQuery,
): Promise<BoardSnapshot> {
  const query = parsed(entryQuerySchema, input);
  const scope = `${streamer.id}:${query.kind}`;
  const cursor = decodeCursor(query.cursor, scope, query.sort, query.query);
  const escapedQuery = query.query.replaceAll(/[\\%_]/gu, String.raw`\$&`);
  const parameters: (string | number)[] = [viewerId ?? "", viewerId ?? "", streamer.id, `%${escapedQuery}%`];
  let where = "";
  if (cursor) {
    where = query.sort === "top" ? "WHERE (score,created_at,id) < (?,?,?)" : "WHERE (created_at,id) < (?,?)";
    if (query.sort === "top") parameters.push(cursor.score);
    parameters.push(cursor.time, cursor.id);
  }
  const entriesQuery = env.DB.prepare(String.raw`SELECT * FROM (${entrySelect}
    WHERE e.streamer_id=? AND e.kind ${query.kind === "topics" ? "= 'topic'" : "!= 'topic'"}
      AND e.title LIKE ? ESCAPE '\') ${where}
    ORDER BY ${query.sort === "top" ? "score DESC," : ""}created_at DESC,id DESC LIMIT ${PAGE_SIZE + 1}
  `).bind(...parameters);
  const results = await env.DB.batch([
    env.DB.prepare("SELECT revision FROM streamers WHERE id=?").bind(streamer.id),
    entriesQuery,
  ]);
  const revision = (results[0]?.results[0] as { revision: number } | undefined)?.revision;
  if (revision === undefined) throw new HttpError(404, "Streamer not found.");
  const rows = results[1].results as unknown as EntryRow[];
  const page = rows.slice(0, PAGE_SIZE);
  const last = page.at(-1);
  return {
    streamer,
    entries: page.map(entryValue),
    revision,
    serverNow: Date.now(),
    nextCursor:
      rows.length > PAGE_SIZE && last
        ? encodeCursor({
            scope,
            sort: query.sort,
            query: query.query,
            score: last.score,
            time: last.created_at,
            id: last.id,
          })
        : null,
  };
}

export async function listComments(
  env: AppEnv,
  entryId: string,
  viewerId: string | null,
  input: CommentQuery,
): Promise<DiscussionSnapshot> {
  const query = parsed(commentQuerySchema, input);
  const cursor = decodeCursor(query.cursor, entryId, query.sort);
  const parameters: (string | number)[] = [viewerId ?? "", entryId];
  let where = "";
  if (cursor) {
    where = query.sort === "top" ? "WHERE (likes,created_at,id) < (?,?,?)" : "WHERE (created_at,id) < (?,?)";
    if (query.sort === "top") parameters.push(cursor.score);
    parameters.push(cursor.time, cursor.id);
  }
  const result = await env.DB.prepare(`SELECT * FROM (
    SELECT c.*, u.name AS author, u.image AS avatar,
      (SELECT count(*) FROM comment_likes l WHERE l.comment_id=c.id) AS likes,
      EXISTS(SELECT 1 FROM comment_likes l WHERE l.comment_id=c.id AND l.user_id=?) AS liked
    FROM entry_comments c JOIN user u ON u.id=c.author_id WHERE c.entry_id=?
  ) ${where} ORDER BY ${query.sort === "top" ? "likes DESC," : ""}created_at DESC,id DESC LIMIT ${COMMENT_PAGE_SIZE + 1}`)
    .bind(...parameters)
    .all<CommentRow>();
  const rows = result.results.slice(0, COMMENT_PAGE_SIZE);
  const last = rows.at(-1);
  return {
    comments: rows.map(
      (row: CommentRow): Comment => ({
        id: row.id,
        entryId: row.entry_id,
        authorId: row.author_id,
        author: row.author,
        avatar: publicAvatar(row.author_id, row.avatar),
        text: row.text,
        createdAt: row.created_at,
        parentId: row.parent_id,
        likes: row.likes,
        liked: row.liked === 1,
      }),
    ),
    nextCursor:
      result.results.length > COMMENT_PAGE_SIZE && last
        ? encodeCursor({
            scope: entryId,
            sort: query.sort,
            query: "",
            score: last.likes,
            time: last.created_at,
            id: last.id,
          })
        : null,
  };
}

async function applyMutation(
  env: AppEnv,
  streamerId: string,
  statement: D1PreparedStatement,
  errorStatus: number,
  errorMessage: string,
  allowNoChange = false,
): Promise<void> {
  const result = await env.DB.batch([
    statement,
    env.DB.prepare("UPDATE streamers SET revision=revision+1 WHERE id=?").bind(streamerId),
  ]);
  if (!allowNoChange && result[0].meta.changes === 0) throw new HttpError(errorStatus, errorMessage);
}

async function entryPermission(env: AppEnv, id: string, streamerId: string): Promise<PermissionRow> {
  const row = await env.DB.prepare(
    "SELECT e.id,e.streamer_id,e.author_id,e.kind,s.owner_id FROM entries e JOIN streamers s ON s.id=e.streamer_id WHERE e.id=? AND e.streamer_id=?",
  )
    .bind(id, streamerId)
    .first<PermissionRow>();
  if (!row) throw new HttpError(404, "Topic or poll not found.");
  return row;
}

async function createEntry(
  env: AppEnv,
  userId: string,
  streamerId: string,
  action: Extract<EntryAction, { action: "create" }>,
): Promise<{ id: string }> {
  const id = crypto.randomUUID();
  const options = action.kind === "binary" ? ["Yes", "No"] : (action.options ?? []);
  const now = Date.now();
  await applyMutation(
    env,
    streamerId,
    env.DB.prepare(`
    INSERT INTO entries (id,streamer_id,author_id,kind,title,body,category,options,created_at,ends_at,revealed)
    SELECT ?,s.id,?,?,?,?,?,?,?,?,0 FROM streamers s WHERE s.id=? AND (?='topic' OR s.owner_id=?)
      AND (SELECT count(*) FROM entries e WHERE e.streamer_id=s.id) < ?
  `).bind(
      id,
      userId,
      action.kind,
      action.title,
      action.kind === "topic" ? (action.body ?? "") : "",
      action.kind === "topic" ? (action.category ?? "") : "",
      JSON.stringify(action.kind === "topic" ? [] : options),
      now,
      action.kind !== "topic" && action.duration > 0 ? now + action.duration * 1000 : null,
      streamerId,
      action.kind,
      userId,
      MAX_ENTRIES,
    ),
    403,
    "Only the streamer can create polls. Each page can contain up to 1000 topics and polls.",
  );
  return { id };
}

export async function mutateEntry(
  env: AppEnv,
  viewerId: string,
  streamerId: string,
  input: unknown,
): Promise<{ id: string }> {
  const action = parsed(entryActionSchema, input);
  await consumeMutationQuota(env, viewerId);
  if (action.action === "create" || action.action === "comment") await consumeMutationQuota(env, viewerId, true);
  if (action.action === "create") return createEntry(env, viewerId, streamerId, action);
  const permission = await entryPermission(env, action.id, streamerId);
  switch (action.action) {
    case "vote": {
      await applyMutation(
        env,
        streamerId,
        env.DB.prepare(`
        INSERT INTO entry_votes (entry_id,user_id,choice)
        SELECT id,?,? FROM entries WHERE id=? AND streamer_id=? AND kind!='topic' AND revealed=0
          AND (ends_at IS NULL OR ends_at>CAST(strftime('%s','now') AS INTEGER)*1000+CAST(substr(strftime('%f','now'),4,3) AS INTEGER)) AND ?<json_array_length(options)
        ON CONFLICT(entry_id,user_id) DO UPDATE SET choice=excluded.choice
      `).bind(viewerId, action.choice, action.id, streamerId, action.choice),
        409,
        "Voting is closed or the option is not valid.",
      );
      break;
    }
    case "react": {
      const statement =
        action.value === 0
          ? env.DB.prepare(
              "DELETE FROM entry_reactions WHERE entry_id=? AND user_id=? AND EXISTS(SELECT 1 FROM entries WHERE id=? AND streamer_id=?)",
            ).bind(action.id, viewerId, action.id, streamerId)
          : env.DB.prepare(`INSERT INTO entry_reactions (entry_id,user_id,value)
          SELECT id,?,? FROM entries WHERE id=? AND streamer_id=?
          ON CONFLICT(entry_id,user_id) DO UPDATE SET value=excluded.value`).bind(
              viewerId,
              action.value,
              action.id,
              streamerId,
            );
      await applyMutation(env, streamerId, statement, 404, "Topic or poll not found.", action.value === 0);
      break;
    }
    case "reveal": {
      if (permission.owner_id !== viewerId) throw new HttpError(403, "Only the streamer can reveal poll results.");
      await applyMutation(
        env,
        streamerId,
        env.DB.prepare(`UPDATE entries SET revealed=1
        WHERE id=? AND streamer_id=? AND kind!='topic' AND EXISTS(SELECT 1 FROM streamers s WHERE s.id=entries.streamer_id AND s.owner_id=?)`).bind(
          action.id,
          streamerId,
          viewerId,
        ),
        404,
        "Poll not found.",
      );
      break;
    }
    case "delete": {
      if (permission.author_id !== viewerId && permission.owner_id !== viewerId)
        throw new HttpError(403, "Only the author or streamer can remove this item.");
      await applyMutation(
        env,
        streamerId,
        env.DB.prepare(`DELETE FROM entries WHERE id=? AND streamer_id=?
        AND (author_id=? OR EXISTS(SELECT 1 FROM streamers s WHERE s.id=entries.streamer_id AND s.owner_id=?))`).bind(
          action.id,
          streamerId,
          viewerId,
          viewerId,
        ),
        404,
        "Topic or poll not found.",
      );
      break;
    }
    case "comment": {
      const id = crypto.randomUUID();
      await applyMutation(
        env,
        streamerId,
        env.DB.prepare(`INSERT INTO entry_comments (id,entry_id,author_id,text,created_at,parent_id)
        SELECT ?,id,?,?,?,? FROM entries WHERE id=? AND streamer_id=?
          AND (? IS NULL OR EXISTS(SELECT 1 FROM entry_comments p WHERE p.id=? AND p.entry_id=entries.id))
          AND (SELECT count(*) FROM entry_comments c WHERE c.entry_id=entries.id) < ?
      `).bind(
          id,
          viewerId,
          action.text,
          Date.now(),
          action.parentId ?? null,
          action.id,
          streamerId,
          action.parentId ?? null,
          action.parentId ?? null,
          MAX_COMMENTS,
        ),
        400,
        "Reply target is invalid or the discussion has reached 10000 comments.",
      );
      return { id };
    }
  }
  return { id: action.id };
}

export async function mutateComment(env: AppEnv, viewerId: string, input: unknown): Promise<{ id: string }> {
  const action = parsed(commentActionSchema, input);
  await consumeMutationQuota(env, viewerId);
  const comment = await env.DB.prepare(`SELECT c.author_id,e.streamer_id,s.owner_id FROM entry_comments c
    JOIN entries e ON e.id=c.entry_id JOIN streamers s ON s.id=e.streamer_id WHERE c.id=?`)
    .bind(action.id)
    .first<{ author_id: string; streamer_id: string; owner_id: string }>();
  if (!comment) throw new HttpError(404, "Comment not found.");
  if (action.action === "like") {
    const statement = action.liked
      ? env.DB.prepare(
          "INSERT INTO comment_likes (comment_id,user_id) SELECT id,? FROM entry_comments WHERE id=? ON CONFLICT(comment_id,user_id) DO NOTHING",
        ).bind(viewerId, action.id)
      : env.DB.prepare("DELETE FROM comment_likes WHERE comment_id=? AND user_id=?").bind(action.id, viewerId);
    await applyMutation(env, comment.streamer_id, statement, 404, "Comment not found.", true);
  } else {
    if (comment.author_id !== viewerId && comment.owner_id !== viewerId)
      throw new HttpError(403, "Only the author or streamer can remove this comment.");
    const ownership =
      "SELECT c.id FROM entry_comments c JOIN entries e ON e.id=c.entry_id JOIN streamers s ON s.id=e.streamer_id WHERE c.id=? AND (c.author_id=? OR s.owner_id=?)";
    const result = await env.DB.batch([
      env.DB.prepare(`UPDATE entry_comments SET parent_id=NULL WHERE parent_id IN (${ownership})`).bind(
        action.id,
        viewerId,
        viewerId,
      ),
      env.DB.prepare(`DELETE FROM entry_comments WHERE id IN (${ownership})`).bind(action.id, viewerId, viewerId),
      env.DB.prepare("UPDATE streamers SET revision=revision+1 WHERE id=?").bind(comment.streamer_id),
    ]);
    if (result[1].meta.changes === 0) throw new HttpError(404, "Comment not found.");
  }
  return { id: action.id };
}
