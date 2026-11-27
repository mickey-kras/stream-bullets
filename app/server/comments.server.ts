import type { AppEnv } from "../env";
import type {
  Comment,
  CommentMention,
  CommentRevision,
  CommentThread,
  DiscussionSnapshot,
  ThreadSnapshot,
} from "../types";
import { ANSWER_COLUMN, answerValue } from "./comment-answers.server";
import { mentionStatements, validateMentions } from "./discussion-notifications.server";
import { assertStreamerWritable, isAdmin } from "./access.server";
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
  getVisibleEntry,
} from "./data.server";
import { HttpError } from "./http.server";
import { VISIBLE_REPLIES } from "../lib/threads";
import { commentActionSchema, commentQuerySchema, type CommentQuery } from "./validation";

// Flat/threaded discussions, likes, and removal placeholders.

const COMMENT_PAGE_SIZE = 100;

interface CommentRow {
  id: string;
  entry_id: string;
  author_id: string;
  text: string;
  created_at: number;
  edited_at: number | null;
  mentions: string;
  parent_id: string | null;
  removed_at: number | null;
  author: string;
  avatar: string | null;
  avatar_preset: number | null;
  likes: number;
  liked: number;
  reported: number;
  answer: string | null;
}

const commentColumns = `c.*,
      coalesce((SELECT json_group_array(json_object('userId',m.user_id,'start',m.start,'end',m.end))
        FROM comment_mentions m WHERE m.comment_id=c.id),'[]') AS mentions, u.name AS author, u.image AS avatar, u.avatar_preset,
      (SELECT count(*) FROM comment_likes l WHERE l.comment_id=c.id) AS likes,
      EXISTS(SELECT 1 FROM comment_likes l WHERE l.comment_id=c.id AND l.user_id=?) AS liked,
      EXISTS(SELECT 1 FROM content_reports cr WHERE cr.target_kind='comment' AND cr.target_id=c.id
        AND cr.reporter_id=? AND cr.status='open') AS reported, ${ANSWER_COLUMN}`;

// A removed comment keeps its place in the thread but shows no author, text or likes.
function commentValue(row: CommentRow): Comment {
  const removed = row.removed_at !== null;
  return {
    id: row.id,
    entryId: row.entry_id,
    authorId: removed ? "" : row.author_id,
    author: removed ? "" : row.author,
    avatar: removed ? null : publicAvatar(row.author_id, row.avatar),
    avatarPreset: removed ? null : row.avatar_preset,
    text: removed ? "" : row.text,
    createdAt: row.created_at,
    editedAt: removed ? null : row.edited_at,
    mentions: removed ? [] : (JSON.parse(row.mentions) as NonNullable<Comment["mentions"]>),
    parentId: row.parent_id,
    likes: removed ? 0 : row.likes,
    liked: !removed && row.liked === 1,
    removed,
    reported: !removed && row.reported === 1,
    ...(removed || row.answer === null ? {} : { answer: answerValue(row.answer) }),
  };
}

// The replies one request loads at most.
const REPLY_PAGE_SIZE = 50;
// The replies before and after the comment of a link to a reply.
const LINKED_CONTEXT = 10;

interface ReplyRow extends CommentRow {
  parent_author: string | null;
  parent_removed: number | null;
}

// The replies of a thread, any depth, as one list, oldest first.
const threadIds = `thread(root, id) AS (
      SELECT c.id, c.id FROM entry_comments c WHERE c.id IN (SELECT value FROM json_each(?))
      UNION ALL SELECT t.root, c.id FROM entry_comments c JOIN thread t ON c.parent_id=t.id
    )`;
const replyColumns = `${commentColumns}, pu.name AS parent_author, p.removed_at IS NOT NULL AS parent_removed`;

function replyValue(row: ReplyRow): Comment {
  const parentAuthor = row.parent_removed === 1 ? "" : (row.parent_author ?? "");
  return { ...commentValue(row), parentAuthor };
}

interface ReplyWindow {
  replies: Comment[];
  replyCount: number;
  earlierReplies: number;
}

// The first `VISIBLE_REPLIES` replies of each root, or, with `focus`, the replies around that reply. Each thread also
// gets its reply count, so the page can load the rest on demand.
async function replyWindows(
  env: AppEnv,
  rootIds: string[],
  viewerId: string | null,
  focus: string | null = null,
): Promise<Map<string, ReplyWindow>> {
  const windows = new Map<string, ReplyWindow>(
    rootIds.map((id: string): [string, ReplyWindow] => [id, { replies: [], replyCount: 0, earlierReplies: 0 }]),
  );
  if (rootIds.length === 0) return windows;
  const { results } = await env.DB.prepare(`
    WITH RECURSIVE ${threadIds}, ordered AS (
      SELECT t.root, t.id, row_number() OVER (PARTITION BY t.root ORDER BY c.created_at, c.id) AS n,
        count(*) OVER (PARTITION BY t.root) AS total
      FROM thread t JOIN entry_comments c ON c.id=t.id WHERE t.id<>t.root
    ), focus AS (SELECT root, n FROM ordered WHERE id=?)
    SELECT o.root, o.n, o.total, ${replyColumns}
    FROM ordered o LEFT JOIN focus f ON f.root=o.root JOIN entry_comments c ON c.id=o.id JOIN user u ON u.id=c.author_id
      LEFT JOIN entry_comments p ON p.id=c.parent_id LEFT JOIN user pu ON pu.id=p.author_id
    WHERE (f.n IS NULL AND o.n <= ?) OR o.n BETWEEN f.n - ? AND f.n + ?
    ORDER BY o.root, o.n
  `)
    .bind(
      JSON.stringify(rootIds),
      focus ?? "",
      viewerId ?? "",
      viewerId ?? "",
      VISIBLE_REPLIES,
      LINKED_CONTEXT,
      LINKED_CONTEXT,
    )
    .all<ReplyRow & { root: string; n: number; total: number }>();
  for (const row of results) {
    const window = windows.get(row.root);
    if (!window) continue;
    if (window.replies.length === 0) window.earlierReplies = row.n - 1;
    window.replyCount = row.total;
    window.replies.push(replyValue(row));
  }
  return windows;
}

// Where a page of replies starts: after, before or at the position of a reply, by its time and ID. The values, not
// the row, set the place, so a page still works after another reader deleted the reply it starts from.
export interface ReplyAnchor {
  direction: "after" | "before" | "from";
  createdAt: number;
  id: string;
}

// A page of replies with the number of replies of the thread before its first one. `earlierReplies` is null for
// an empty page.
export interface ReplyPage {
  replies: Comment[];
  earlierReplies: number | null;
  // All replies of the thread now, so a reader's count follows replies that others deleted.
  replyCount: number;
}

const ANCHOR_OPERATOR: Readonly<Record<ReplyAnchor["direction"], string>> = { after: ">", before: "<", from: ">=" };

// The replies of thread `rootId` next to `anchor`, oldest first; the first ones without an anchor.
async function replyPage(
  env: AppEnv,
  rootId: string,
  viewerId: string | null,
  anchor: ReplyAnchor | null,
): Promise<ReplyPage> {
  const before = anchor?.direction === "before";
  const order = before ? "DESC" : "ASC";
  const where = anchor ? `WHERE (c.created_at, c.id) ${ANCHOR_OPERATOR[anchor.direction]} (?, ?)` : "";
  const [page, total] = await env.DB.batch([
    env.DB.prepare(`
    WITH RECURSIVE ${threadIds}, ordered AS (
      SELECT t.id, row_number() OVER (ORDER BY c.created_at, c.id) AS n
      FROM thread t JOIN entry_comments c ON c.id=t.id WHERE t.id<>t.root
    )
    SELECT o.n, ${replyColumns} FROM ordered o JOIN entry_comments c ON c.id=o.id JOIN user u ON u.id=c.author_id
      LEFT JOIN entry_comments p ON p.id=c.parent_id LEFT JOIN user pu ON pu.id=p.author_id
    ${where}
    ORDER BY c.created_at ${order}, c.id ${order} LIMIT ?
  `).bind(
      JSON.stringify([rootId]),
      viewerId ?? "",
      viewerId ?? "",
      ...(anchor ? [anchor.createdAt, anchor.id] : []),
      REPLY_PAGE_SIZE,
    ),
    env.DB.prepare(`WITH RECURSIVE ${threadIds} SELECT count(*) - 1 AS n FROM thread`).bind(JSON.stringify([rootId])),
  ]);
  const results = page.results as (ReplyRow & { n: number })[];
  const rows = before ? results.reverse() : results;
  return {
    replies: rows.map(replyValue),
    earlierReplies: rows.length ? rows[0].n - 1 : null,
    replyCount: (total.results[0] as { n: number } | undefined)?.n ?? 0,
  };
}

function threadValue(row: CommentRow, window: ReplyWindow | undefined): CommentThread {
  return { ...commentValue(row), ...(window ?? { replies: [], replyCount: 0, earlierReplies: 0 }) };
}

// Page flat comments or top-level threads by newest/likes; each thread has a preview of its oldest replies.
// Both views retain removed parents as placeholders.
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
  const windows = await replyWindows(
    env,
    rows.map((row: CommentRow): string => row.id),
    viewerId,
  );
  return {
    comments: rows.map((row: CommentRow): CommentThread => threadValue(row, windows.get(row.id))),
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

// Text kept in a removed comment's row; the API never shows it.
export const REMOVED_COMMENT_TEXT = "[removed]";

// With replies, erase text/likes and retain a placeholder. Otherwise delete the row and empty ancestor
// placeholders. Account deletion removes comments outright and promotes replies to top level.
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
  // Exactly one of the two changes below applies (a comment either has replies or not). The audit row after
  // each one is written only when that change happened.
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
    env.DB.prepare("DELETE FROM notifications WHERE comment_id=?").bind(id),
    env.DB.prepare("DELETE FROM comment_mentions WHERE comment_id=?").bind(id),
    // A placeholder keeps its row, so its earlier texts need their own statement too.
    env.DB.prepare(
      "DELETE FROM comment_revisions WHERE comment_id=? AND NOT EXISTS(SELECT 1 FROM entry_comments WHERE id=? AND removed_at IS NULL)",
    ).bind(id, id),
    // A removed comment loses its "Answered" mark; a placeholder keeps its row, so this needs its own statement.
    env.DB.prepare(
      "DELETE FROM comment_answers WHERE comment_id=? AND NOT EXISTS(SELECT 1 FROM entry_comments WHERE id=? AND removed_at IS NULL)",
    ).bind(id, id),
    // A placeholder keeps its row, so the stored translations of the removed text need their own statement.
    env.DB.prepare(
      "DELETE FROM comment_translations WHERE comment_id=? AND NOT EXISTS(SELECT 1 FROM entry_comments WHERE id=? AND removed_at IS NULL)",
    ).bind(id, id),
    env.DB.prepare("UPDATE streamers SET revision=revision+1 WHERE id=?").bind(comment.streamer_id),
  ];
  const result = await env.DB.batch(statements);
  const placeholder = result[0].meta.changes;
  const deleted = result[2 + audited.length].meta.changes;
  if (placeholder === 0 && deleted === 0) throw new HttpError(404, "Comment not found.");
}

// Removes a comment with the same rules as a delete action. Returns the streamer page it belonged to.
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
  if (action.action === "edit") {
    if (comment.author_id !== viewerId) throw new HttpError(403, "Only the author can edit this comment.");
    await consumeMutationQuota(env, viewerId, true);
    await validateMentions(env, comment.streamer_id, action.text, action.mentions, action.id);
    const now = Date.now();
    const result = await env.DB.batch([
      // Keep the text before the edit for the page owner and admins. An edit that keeps the text stores nothing.
      // The text was written by the last edit that changed it; without a stored one, by the last edit or the post.
      env.DB.prepare(`INSERT INTO comment_revisions (comment_id,text,mentions,written_at,edited_at)
        SELECT c.id,c.text,(SELECT json_group_array(json_object('userId',m.user_id,'start',m.start,'end',m.end))
          FROM comment_mentions m WHERE m.comment_id=c.id),
          coalesce((SELECT max(r.edited_at) FROM comment_revisions r WHERE r.comment_id=c.id),c.edited_at,c.created_at),?
        FROM entry_comments c WHERE c.id=? AND c.author_id=? AND c.removed_at IS NULL AND c.text<>?`).bind(
        now,
        action.id,
        viewerId,
        action.text,
      ),
      env.DB.prepare(
        "UPDATE entry_comments SET text=?,edited_at=? WHERE id=? AND author_id=? AND removed_at IS NULL",
      ).bind(action.text, now, action.id, viewerId),
      env.DB.prepare("DELETE FROM comment_mentions WHERE comment_id=?").bind(action.id),
      // The stored translations are of the text before the edit.
      env.DB.prepare(
        "DELETE FROM comment_translations WHERE comment_id=? AND EXISTS(SELECT 1 FROM entry_comments WHERE id=? AND author_id=?)",
      ).bind(action.id, action.id, viewerId),
      ...mentionStatements(env, action.id, action.mentions),
      env.DB.prepare(`DELETE FROM notifications WHERE comment_id=? AND kind='mention'
        AND NOT EXISTS(SELECT 1 FROM comment_mentions m WHERE m.comment_id=notifications.comment_id AND m.user_id=notifications.user_id)`).bind(
        action.id,
      ),
      env.DB.prepare("UPDATE streamers SET revision=revision+1 WHERE id=?").bind(comment.streamer_id),
    ]);
    if (!result[1].meta.changes) throw new HttpError(404, "Comment not found.");
  } else if (action.action === "like") {
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

export async function getCommentThread(
  env: AppEnv,
  id: string,
  viewerId: string | null,
): Promise<{
  comment: Comment;
  rootId: string;
  thread: CommentThread;
  handle: string;
  entryId: string;
}> {
  const row = await env.DB.prepare(
    `SELECT ${commentColumns} FROM entry_comments c JOIN user u ON u.id=c.author_id WHERE c.id=?`,
  )
    .bind(viewerId ?? "", viewerId ?? "", id)
    .first<CommentRow>();
  if (row?.removed_at !== null || !(await getVisibleEntry(env, row.entry_id, viewerId)))
    throw new HttpError(404, "Comment not found.");
  const root = await env.DB.prepare(`WITH RECURSIVE ancestors(id,parent_id) AS (
    SELECT id,parent_id FROM entry_comments WHERE id=?
    UNION ALL SELECT c.id,c.parent_id FROM entry_comments c JOIN ancestors a ON c.id=a.parent_id
  ) SELECT id FROM ancestors WHERE parent_id IS NULL`)
    .bind(id)
    .first<{ id: string }>();
  if (!root) throw new HttpError(404, "Comment not found.");
  const rootRow = await env.DB.prepare(
    `SELECT ${commentColumns} FROM entry_comments c JOIN user u ON u.id=c.author_id WHERE c.id=?`,
  )
    .bind(viewerId ?? "", viewerId ?? "", root.id)
    .first<CommentRow>();
  const page = await env.DB.prepare(
    "SELECT s.handle FROM streamers s JOIN entries e ON e.streamer_id=s.id WHERE e.id=?",
  )
    .bind(row.entry_id)
    .first<{ handle: string }>();
  if (!rootRow || !page) throw new HttpError(404, "Comment not found.");
  // A linked reply comes with the replies around it, not with the whole thread.
  const windows = await replyWindows(env, [root.id], viewerId, id === root.id ? null : id);
  return {
    comment: commentValue(row),
    rootId: root.id,
    thread: threadValue(rootRow, windows.get(root.id)),
    handle: page.handle,
    entryId: row.entry_id,
  };
}

// `GET /api/comments/:id/replies`: up to 50 replies of a thread after, before or from a place, oldest first.
export async function listReplies(
  env: AppEnv,
  rootId: string,
  viewerId: string | null,
  anchor: ReplyAnchor | null,
): Promise<ReplyPage> {
  const root = await env.DB.prepare("SELECT entry_id FROM entry_comments WHERE id=? AND parent_id IS NULL")
    .bind(rootId)
    .first<{ entry_id: string }>();
  if (!root || !(await getVisibleEntry(env, root.entry_id, viewerId))) throw new HttpError(404, "Comment not found.");
  return replyPage(env, rootId, viewerId, anchor);
}

// Earlier texts kept for 90 days after the edit that replaced them.
export const REVISION_RETENTION_MS = 90 * 86_400_000;

// The earlier texts of a comment, oldest first. Only the owner of the page and admins can read them; an admin
// passes the step-up gate. Everyone else, the author included, gets the same 404 as for a missing comment.
export async function listCommentRevisions(
  env: AppEnv,
  viewerId: string,
  id: string,
  stepUp: () => Promise<unknown>,
): Promise<CommentRevision[]> {
  const comment = await env.DB.prepare(
    `SELECT s.owner_id,c.removed_at FROM entry_comments c JOIN entries e ON e.id=c.entry_id
      JOIN streamers s ON s.id=e.streamer_id WHERE c.id=?`,
  )
    .bind(id)
    .first<{ owner_id: string; removed_at: number | null }>();
  if (comment?.removed_at !== null) throw new HttpError(404, "Comment not found.");
  if (comment.owner_id !== viewerId) {
    if (!(await isAdmin(env, viewerId))) throw new HttpError(404, "Comment not found.");
    await stepUp();
  }
  const { results } = await env.DB.prepare(
    "SELECT text,mentions,written_at,edited_at FROM comment_revisions WHERE comment_id=? ORDER BY edited_at,id",
  )
    .bind(id)
    .all<{ text: string; mentions: string; written_at: number; edited_at: number }>();
  return results.map(
    (row): CommentRevision => ({
      text: row.text,
      mentions: JSON.parse(row.mentions) as CommentMention[],
      writtenAt: row.written_at,
      editedAt: row.edited_at,
    }),
  );
}
