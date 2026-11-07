import type { AppEnv } from "../env";
import type { Comment, CommentThread, DiscussionSnapshot, ThreadSnapshot } from "../types";
import { assertStreamerWritable } from "./access.server";
import {
  applyMutation,
  consumeMutationQuota,
  decodeCursor,
  encodeCursor,
  parsed,
  publicAvatar,
  adminRemoval,
  type AdminRemovalGate,
  type StepUpGate,
} from "./data.server";
import { HttpError } from "./http.server";
import { commentActionSchema, commentQuerySchema, type CommentQuery } from "./validation";

/** Discussions: listing comments flat or by thread, likes, and removal with the R2 placeholder rules. */

const COMMENT_PAGE_SIZE = 100;

interface CommentRow {
  id: string;
  entry_id: string;
  author_id: string;
  text: string;
  created_at: number;
  parent_id: string | null;
  removed_at: number | null;
  author: string;
  avatar: string | null;
  likes: number;
  liked: number;
  reported: number;
}

const commentColumns = `c.*, u.name AS author, u.image AS avatar,
      (SELECT count(*) FROM comment_likes l WHERE l.comment_id=c.id) AS likes,
      EXISTS(SELECT 1 FROM comment_likes l WHERE l.comment_id=c.id AND l.user_id=?) AS liked,
      EXISTS(SELECT 1 FROM content_reports cr WHERE cr.target_kind='comment' AND cr.target_id=c.id
        AND cr.reporter_id=? AND cr.status='open') AS reported`;

/** A removed comment keeps its place in the thread but shows no author, text or likes (R2). */
function commentValue(row: CommentRow): Comment {
  const removed = row.removed_at !== null;
  return {
    id: row.id,
    entryId: row.entry_id,
    authorId: removed ? "" : row.author_id,
    author: removed ? "" : row.author,
    avatar: removed ? null : publicAvatar(row.author_id, row.avatar),
    text: removed ? "" : row.text,
    createdAt: row.created_at,
    parentId: row.parent_id,
    likes: removed ? 0 : row.likes,
    liked: !removed && row.liked === 1,
    removed,
    reported: !removed && row.reported === 1,
  };
}

/** Every reply under the given top-level comments, any depth, oldest first within each thread. */
async function threadReplies(env: AppEnv, rootIds: string[], viewerId: string | null): Promise<Map<string, Comment[]>> {
  const replies = new Map<string, Comment[]>(rootIds.map((id: string): [string, Comment[]] => [id, []]));
  if (rootIds.length === 0) return replies;
  const { results } = await env.DB.prepare(`
    WITH RECURSIVE thread(root, id) AS (
      SELECT c.id, c.id FROM entry_comments c WHERE c.id IN (SELECT value FROM json_each(?))
      UNION ALL SELECT t.root, c.id FROM entry_comments c JOIN thread t ON c.parent_id=t.id
    )
    SELECT t.root, ${commentColumns}
    FROM thread t JOIN entry_comments c ON c.id=t.id JOIN user u ON u.id=c.author_id
    WHERE t.id<>t.root ORDER BY t.root, c.created_at, c.id
  `)
    .bind(JSON.stringify(rootIds), viewerId ?? "", viewerId ?? "")
    .all<CommentRow & { root: string }>();
  for (const row of results) replies.get(row.root)?.push(commentValue(row));
  return replies;
}

/**
 * Lists a discussion. The default `flat` view pages every comment newest or most liked first.
 * The `thread` view pages top-level comments the same way and attaches each one's replies, oldest
 * first (item 40). Removed comments with replies come back as placeholders in both views.
 */
export async function listComments(
  env: AppEnv,
  entryId: string,
  viewerId: string | null,
  input: CommentQuery,
): Promise<DiscussionSnapshot | ThreadSnapshot> {
  const query = parsed(commentQuerySchema, input);
  const threaded = query.view === "thread";
  const scope = threaded ? `${entryId}:thread` : entryId;
  const cursor = decodeCursor(query.cursor, scope, query.sort);
  const parameters: (string | number)[] = [viewerId ?? "", viewerId ?? "", entryId];
  let where = "";
  if (cursor) {
    where = query.sort === "top" ? "WHERE (likes,created_at,id) < (?,?,?)" : "WHERE (created_at,id) < (?,?)";
    if (query.sort === "top") parameters.push(cursor.score);
    parameters.push(cursor.time, cursor.id);
  }
  const result = await env.DB.prepare(`SELECT * FROM (
    SELECT ${commentColumns}
    FROM entry_comments c JOIN user u ON u.id=c.author_id WHERE c.entry_id=?${threaded ? " AND c.parent_id IS NULL" : ""}
  ) ${where} ORDER BY ${query.sort === "top" ? "likes DESC," : ""}created_at DESC,id DESC LIMIT ${COMMENT_PAGE_SIZE + 1}`)
    .bind(...parameters)
    .all<CommentRow>();
  const rows = result.results.slice(0, COMMENT_PAGE_SIZE);
  const last = rows.at(-1);
  const nextCursor =
    result.results.length > COMMENT_PAGE_SIZE && last
      ? encodeCursor({ scope, sort: query.sort, query: "", score: last.likes, time: last.created_at, id: last.id })
      : null;
  if (!threaded) return { comments: rows.map(commentValue), nextCursor };
  const replies = await threadReplies(
    env,
    rows.map((row: CommentRow): string => row.id),
    viewerId,
  );
  return {
    comments: rows.map(
      (row: CommentRow): CommentThread => ({ ...commentValue(row), replies: replies.get(row.id) ?? [] }),
    ),
    nextCursor,
  };
}

interface CommentPermission {
  entry_id: string;
  author_id: string;
  streamer_id: string;
  owner_id: string;
  parent_id: string | null;
}

async function commentPermission(env: AppEnv, id: string): Promise<CommentPermission> {
  const comment =
    await env.DB.prepare(`SELECT c.entry_id,c.author_id,c.parent_id,e.streamer_id,s.owner_id FROM entry_comments c
    JOIN entries e ON e.id=c.entry_id JOIN streamers s ON s.id=e.streamer_id WHERE c.id=?`)
      .bind(id)
      .first<CommentPermission>();
  if (!comment) throw new HttpError(404, "Comment not found.");
  return comment;
}

/** Text kept in a removed comment's row; the API never shows it. */
export const REMOVED_COMMENT_TEXT = "[removed]";

/**
 * Deletes a comment (R2). A comment with replies becomes a "Comment removed" placeholder: its text
 * is erased, its likes go, and the thread keeps its shape. A comment without replies is deleted, and
 * every placeholder above it left with no replies is deleted with it. Account deletion still removes the
 * account's comments outright; replies under them become top-level comments.
 */
async function removeComment(
  env: AppEnv,
  viewerId: string,
  id: string,
  comment: CommentPermission,
  gate: AdminRemovalGate | undefined,
): Promise<void> {
  // The audit target kinds stop at `entry`, so a comment removal is logged on its topic or poll.
  const { admin, audit } = await adminRemoval(
    env,
    viewerId,
    {
      authorId: comment.author_id,
      ownerId: comment.owner_id,
      denied: "Only the author or streamer can remove this comment.",
    },
    gate,
    {
      targetKind: "entry",
      targetId: comment.entry_id,
      streamerId: comment.streamer_id,
      action: "comment_removed",
      metadata: { commentId: id, via: "page" },
    },
  );
  const ownership =
    "SELECT c.id FROM entry_comments c JOIN entries e ON e.id=c.entry_id JOIN streamers s ON s.id=e.streamer_id WHERE c.id=? AND (?=1 OR c.author_id=? OR s.owner_id=?)";
  const scope = [id, admin ? 1 : 0, viewerId, viewerId];
  const hasReplies = "EXISTS(SELECT 1 FROM entry_comments r WHERE r.parent_id=entry_comments.id)";
  // Exactly one of the two changes below applies (a comment either has replies or not). The audit row after each
  // one is written only when that change happened.
  const audited = audit ? [audit] : [];
  const statements = [
    env.DB.prepare(
      `UPDATE entry_comments SET removed_at=?, text=? WHERE id IN (${ownership}) AND removed_at IS NULL AND ${hasReplies}`,
    ).bind(Date.now(), REMOVED_COMMENT_TEXT, ...scope),
    ...audited,
    env.DB.prepare(
      "DELETE FROM comment_likes WHERE comment_id=? AND EXISTS(SELECT 1 FROM entry_comments WHERE id=? AND removed_at IS NOT NULL)",
    ).bind(id, id),
    env.DB.prepare(`DELETE FROM entry_comments WHERE id IN (${ownership}) AND NOT ${hasReplies}`).bind(...scope),
    ...audited,
    // Placeholders up the chain whose only reply is the next one being deleted: A(removed) → B(removed) → C.
    env.DB.prepare(`WITH RECURSIVE gone(id, parent_id) AS (
        SELECT id, parent_id FROM entry_comments WHERE id=? AND removed_at IS NOT NULL AND NOT ${hasReplies}
        UNION ALL
        SELECT c.id, c.parent_id FROM entry_comments c JOIN gone g ON c.id=g.parent_id
          WHERE c.removed_at IS NOT NULL
            AND NOT EXISTS(SELECT 1 FROM entry_comments r WHERE r.parent_id=c.id AND r.id<>g.id)
      )
      DELETE FROM entry_comments WHERE id IN (SELECT id FROM gone)`).bind(comment.parent_id),
    env.DB.prepare("UPDATE streamers SET revision=revision+1 WHERE id=?").bind(comment.streamer_id),
  ];
  const result = await env.DB.batch(statements);
  const placeholder = result[0].meta.changes;
  const deleted = result[2 + audited.length].meta.changes;
  if (placeholder === 0 && deleted === 0) throw new HttpError(404, "Comment not found.");
}

/** Removes a comment with the same rules as a delete action. Returns the streamer page it belonged to. */
export async function deleteComment(
  env: AppEnv,
  viewerId: string,
  id: string,
  gate?: AdminRemovalGate,
): Promise<{ streamerId: string }> {
  const comment = await commentPermission(env, id);
  await removeComment(env, viewerId, id, comment, gate);
  return { streamerId: comment.streamer_id };
}

export async function mutateComment(
  env: AppEnv,
  viewerId: string,
  input: unknown,
  stepUp?: StepUpGate,
): Promise<{ id: string }> {
  const action = parsed(commentActionSchema, input);
  await consumeMutationQuota(env, viewerId);
  const comment = await commentPermission(env, action.id);
  await assertStreamerWritable(env, comment.streamer_id, viewerId, { moderation: action.action === "delete" });
  if (action.action === "like") {
    const statement = action.liked
      ? env.DB.prepare(
          "INSERT INTO comment_likes (comment_id,user_id) SELECT id,? FROM entry_comments WHERE id=? AND removed_at IS NULL ON CONFLICT(comment_id,user_id) DO NOTHING",
        ).bind(viewerId, action.id)
      : env.DB.prepare("DELETE FROM comment_likes WHERE comment_id=? AND user_id=?").bind(action.id, viewerId);
    await applyMutation(env, comment.streamer_id, statement, 404, "Comment not found.", true);
  } else {
    await removeComment(env, viewerId, action.id, comment, stepUp);
  }
  return { id: action.id };
}
