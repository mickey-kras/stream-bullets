import type { AppEnv } from "../env";
import type {
  CommentMention,
  MentionCandidate,
  NotificationItem,
  NotificationPreferences,
  NotificationSnapshot,
} from "../types";
import { isAdmin } from "./access.server";
import { publicAvatar } from "./data.server";
import { HttpError } from "./http.server";

const RETENTION_MS = 90 * 86_400_000;
const INBOX_LIMIT = 200;

interface CandidateRow {
  id: string;
  name: string;
  image: string | null;
  avatar_preset: number | null;
  handle: string | null;
}

const candidateSelect = `SELECT u.id,u.name,u.image,u.avatar_preset,
  (SELECT s.handle FROM streamers s WHERE s.owner_id=u.id AND s.status<>'suspended') AS handle
  FROM user u WHERE (u.id IN (SELECT owner_id FROM streamers WHERE id=?)
    OR u.id IN (SELECT c.author_id FROM entry_comments c JOIN entries e ON e.id=c.entry_id
      WHERE e.streamer_id=? AND c.removed_at IS NULL)
    OR u.id IN (SELECT owner_id FROM streamers WHERE status<>'suspended'))`;

export async function mentionCandidates(env: AppEnv, streamerId: string, query: string): Promise<MentionCandidate[]> {
  const { results } = await env.DB.prepare(`${candidateSelect}
    AND (instr(lower(u.name),lower(?))>0 OR u.id IN
      (SELECT owner_id FROM streamers WHERE status<>'suspended' AND instr(handle,lower(?))>0))
    ORDER BY lower(u.name),u.id LIMIT 10`)
    .bind(streamerId, streamerId, query, query)
    .all<CandidateRow>();
  return results.map(
    (row: CandidateRow): MentionCandidate => ({
      id: row.id,
      name: row.name,
      avatar: publicAvatar(row.id, row.image),
      avatarPreset: row.avatar_preset,
      handle: row.handle,
    }),
  );
}

export async function validateMentions(
  env: AppEnv,
  streamerId: string,
  text: string,
  mentions: CommentMention[],
  previousCommentId?: string,
): Promise<void> {
  const sorted = [...mentions].sort((a: CommentMention, b: CommentMention): number => a.start - b.start);
  const seen = new Set<string>();
  let end = 0;
  for (const mention of sorted) {
    if (seen.has(mention.userId) || mention.start < end || mention.end <= mention.start || mention.end > text.length)
      throw new HttpError(400, "Invalid mention selection.");
    seen.add(mention.userId);
    end = mention.end;
  }
  if (mentions.length === 0) return;
  const { results } = await env.DB.prepare(`${candidateSelect} AND u.id IN (SELECT value FROM json_each(?))`)
    .bind(streamerId, streamerId, JSON.stringify(mentions.map((mention: CommentMention): string => mention.userId)))
    .all<CandidateRow>();
  const users = new Map(results.map((row: CandidateRow): [string, string] => [row.id, row.name]));
  const previous = previousCommentId
    ? await env.DB.prepare(`SELECT m.user_id,m.start,m.end,c.text
    FROM comment_mentions m JOIN entry_comments c ON c.id=m.comment_id WHERE c.id=? AND c.removed_at IS NULL`)
        .bind(previousCommentId)
        .all<{ user_id: string; start: number; end: number; text: string }>()
    : null;
  const previousLabels = new Map(
    previous?.results.map((row): [string, string] => [row.user_id, row.text.slice(row.start, row.end)]),
  );
  for (const mention of mentions) {
    const name = users.get(mention.userId);
    const label = text.slice(mention.start, mention.end);
    if (!name || (label !== `@${name}` && label !== previousLabels.get(mention.userId)))
      throw new HttpError(400, "Mentioned account is unavailable. Select the account again.");
  }
}

export function mentionStatements(env: AppEnv, id: string, mentions: CommentMention[]): D1PreparedStatement[] {
  return mentions.map(
    (mention: CommentMention): D1PreparedStatement =>
      env.DB.prepare(
        `INSERT INTO comment_mentions (comment_id,user_id,start,end)
      SELECT id,?,?,? FROM entry_comments WHERE id=? AND removed_at IS NULL`,
      ).bind(mention.userId, mention.start, mention.end, id),
  );
}

export function notificationStatements(env: AppEnv, id: string, actorId: string, now: number): D1PreparedStatement[] {
  const window = Math.floor(now / 3_600_000) * 3_600_000;
  const actorKey = `notify-actor:${actorId}`;
  return [
    env.DB.prepare(`INSERT INTO notifications (id,user_id,actor_id,comment_id,kind,created_at)
      SELECT lower(hex(randomblob(16))),recipients.user_id,?,c.id,recipients.kind,?
      FROM entry_comments c JOIN (
        SELECT p.author_id AS user_id,'reply' AS kind FROM entry_comments p JOIN entry_comments reply ON reply.parent_id=p.id
          LEFT JOIN notification_preferences prefs ON prefs.user_id=p.author_id
          WHERE reply.id=? AND p.removed_at IS NULL AND coalesce(prefs.replies,1)=1
        UNION ALL
        SELECT m.user_id,'mention' FROM comment_mentions m LEFT JOIN notification_preferences prefs ON prefs.user_id=m.user_id
          WHERE m.comment_id=? AND coalesce(prefs.mentions,1)=1
          AND NOT EXISTS(SELECT 1 FROM entry_comments reply JOIN entry_comments p ON p.id=reply.parent_id
            WHERE reply.id=m.comment_id AND p.author_id=m.user_id AND p.removed_at IS NULL AND coalesce(prefs.replies,1)=1)
      ) recipients
      WHERE c.id=? AND c.removed_at IS NULL AND recipients.user_id<>?
        AND coalesce((SELECT count FROM app_rate_limits WHERE key=? AND window_start=?),0)<95
        AND coalesce((SELECT count FROM app_rate_limits WHERE key='notify-recipient:'||json_array(?,recipients.user_id) AND window_start=?),0)<10
      ON CONFLICT(user_id,comment_id) DO NOTHING`).bind(
      actorId,
      now,
      id,
      id,
      id,
      actorId,
      actorKey,
      window,
      actorId,
      window,
    ),
    env.DB.prepare(`INSERT INTO app_rate_limits (key,count,window_start)
      SELECT ?,count(*),? FROM notifications WHERE comment_id=? HAVING count(*)>0
      ON CONFLICT(key) DO UPDATE SET count=CASE WHEN app_rate_limits.window_start=excluded.window_start
        THEN app_rate_limits.count+excluded.count ELSE excluded.count END,window_start=excluded.window_start`).bind(
      actorKey,
      window,
      id,
    ),
    env.DB.prepare(`INSERT INTO app_rate_limits (key,count,window_start)
      SELECT 'notify-recipient:'||json_array(?,user_id),1,? FROM notifications WHERE comment_id=?
      ON CONFLICT(key) DO UPDATE SET count=CASE WHEN app_rate_limits.window_start=excluded.window_start
        THEN app_rate_limits.count+1 ELSE 1 END,window_start=excluded.window_start`).bind(actorId, window, id),
    env.DB.prepare("DELETE FROM notifications WHERE created_at<?").bind(now - RETENTION_MS),
    env.DB.prepare(`DELETE FROM notifications WHERE user_id IN
      (SELECT user_id FROM notifications WHERE comment_id=?) AND id NOT IN
      (SELECT keep.id FROM notifications keep WHERE keep.user_id=notifications.user_id
        ORDER BY keep.created_at DESC,keep.id DESC LIMIT ?)`).bind(id, INBOX_LIMIT),
  ];
}

interface NotificationRow {
  id: string;
  kind: "reply" | "mention";
  comment_id: string;
  entry_id: string;
  entry_kind: string;
  handle: string;
  actor: string;
  created_at: number;
  read: number;
}

const notificationFrom = `FROM notifications n JOIN entry_comments c ON c.id=n.comment_id
  JOIN entries e ON e.id=c.entry_id JOIN streamers s ON s.id=e.streamer_id JOIN user u ON u.id=n.actor_id`;
const notificationWhere = `n.user_id=? AND n.created_at>=? AND c.removed_at IS NULL
  AND (s.status<>'suspended' OR s.owner_id=? OR ?=1)
  AND (n.kind='reply' OR EXISTS(SELECT 1 FROM comment_mentions m WHERE m.comment_id=c.id AND m.user_id=n.user_id))`;

export async function listNotifications(
  env: AppEnv,
  viewerId: string,
  cursor: string | null = null,
): Promise<NotificationSnapshot> {
  const now = Date.now();
  const admin = await isAdmin(env, viewerId);
  const scope: (string | number)[] = [viewerId, now - RETENTION_MS, viewerId, admin ? 1 : 0];
  let after = "";
  const bindings = [...scope];
  if (cursor) {
    const match = /^(\d{1,15})\.([a-f0-9]{32})$/u.exec(cursor);
    if (!match) throw new HttpError(400, "Invalid notification cursor.");
    after = " AND (n.created_at,n.id)<(?,?)";
    bindings.push(Number(match[1]), match[2]);
  }
  const [page, count, preferences] = await Promise.all([
    env.DB.prepare(`SELECT n.*,c.entry_id,e.kind AS entry_kind,s.handle,u.name AS actor
      ${notificationFrom} WHERE ${notificationWhere}${after} ORDER BY n.created_at DESC,n.id DESC LIMIT 51`)
      .bind(...bindings)
      .all<NotificationRow>(),
    env.DB.prepare(`SELECT count(*) AS count ${notificationFrom} WHERE ${notificationWhere} AND n.read=0`)
      .bind(...scope)
      .first<{ count: number }>(),
    env.DB.prepare("SELECT replies,mentions FROM notification_preferences WHERE user_id=?")
      .bind(viewerId)
      .first<{ replies: number; mentions: number }>(),
  ]);
  const rows = page.results.slice(0, 50);
  const last = rows.at(-1);
  return {
    notifications: rows.map(
      (row: NotificationRow): NotificationItem => ({
        id: row.id,
        kind: row.kind,
        commentId: row.comment_id,
        entryId: row.entry_id,
        handle: row.handle,
        href: `/@${row.handle}?view=${row.entry_kind === "topic" ? "topics" : "polls"}&entry=${row.entry_id}&comment=${row.comment_id}`,
        actor: row.actor,
        createdAt: row.created_at,
        read: row.read === 1,
      }),
    ),
    nextCursor: page.results.length > 50 && last ? `${last.created_at}.${last.id}` : null,
    unreadCount: count?.count ?? 0,
    preferences: { replies: (preferences?.replies ?? 1) === 1, mentions: (preferences?.mentions ?? 1) === 1 },
  };
}

export async function saveNotificationPreferences(
  env: AppEnv,
  viewerId: string,
  preferences: NotificationPreferences,
): Promise<void> {
  await env.DB.prepare(`INSERT INTO notification_preferences (user_id,replies,mentions) VALUES (?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET replies=excluded.replies,mentions=excluded.mentions`)
    .bind(viewerId, preferences.replies ? 1 : 0, preferences.mentions ? 1 : 0)
    .run();
}

export async function markNotification(env: AppEnv, viewerId: string, id: string, read: boolean): Promise<void> {
  const result = await env.DB.prepare("UPDATE notifications SET read=? WHERE id=? AND user_id=?")
    .bind(read ? 1 : 0, id, viewerId)
    .run();
  if (!result.meta.changes) throw new HttpError(404, "Notification not found.");
}
