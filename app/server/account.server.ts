import type { AppEnv } from "../env";
import { getOrigin, HttpError } from "./http.server";
import { notifyRoom } from "./live.server";

/** Rows read per query while building an export, so memory grows with one page at a time per query. */
export const EXPORT_PAGE_SIZE = 500;

const NOTES =
  "This file contains the personal data StreamBullets holds about your account. " +
  "Sign-in tokens, provider tokens, and session secrets are not included because they are credentials, not profile data. " +
  "Uploaded images are listed by address; download them from those addresses while your account exists. " +
  "Other people's comments and votes are not included.";

interface UserRow {
  id: string;
  name: string;
  email: string;
  email_verified: number;
  image: string | null;
  created_at: number;
  updated_at: number;
}

interface StreamerRow {
  id: string;
  handle: string;
  name: string;
  about: string;
  avatar: string | null;
  background: string | null;
}

interface ApplicationRow {
  links: string;
  note: string;
  status: string;
  created_at: number;
  updated_at: number;
  reviewed_at: number | null;
}

interface PagedRow {
  row_cursor: number;
}

interface ProviderRow extends PagedRow {
  provider_id: string;
  account_id: string;
  created_at: number;
  updated_at: number;
}

interface SessionRow extends PagedRow {
  created_at: number;
  expires_at: number;
  ip_address: string | null;
  user_agent: string | null;
}

interface EntryRow extends PagedRow {
  id: string;
  handle: string;
  kind: string;
  title: string;
  body: string;
  category: string;
  options: string;
  created_at: number;
  ends_at: number | null;
  revealed: number;
}

interface CommentRow extends PagedRow {
  id: string;
  entry_id: string;
  entry_title: string;
  handle: string;
  text: string;
  created_at: number;
  parent_id: string | null;
}

interface ReactionRow extends PagedRow {
  entry_id: string;
  entry_title: string;
  handle: string;
  value: number;
}

interface VoteRow extends PagedRow {
  entry_id: string;
  entry_title: string;
  handle: string;
  choice: number;
  option: string | null;
}

interface LikeRow extends PagedRow {
  comment_id: string;
  entry_id: string;
  entry_title: string;
  handle: string;
}

interface LegacyVoteRow extends PagedRow {
  poll_id: string;
  choice: number;
}

interface LegacyReactionRow extends PagedRow {
  poll_id: string;
  value: number;
}

interface LegacyCommentRow extends PagedRow {
  id: string;
  poll_id: string;
  text: string;
  created_at: number;
}

export interface ImageRecord {
  kind: "avatar" | "background";
  url: string;
  contentType: string | null;
  bytes: number;
  uploadedAt: string;
}

export interface AccountExport {
  exportedAt: string;
  notes: string;
  account: {
    id: string;
    name: string;
    email: string;
    emailVerified: boolean;
    image: string | null;
    createdAt: string;
    updatedAt: string;
  };
  signInMethods: { providerId: string; accountId: string; createdAt: string; updatedAt: string }[];
  activeSessions: { createdAt: string; expiresAt: string; ipAddress: string | null; userAgent: string | null }[];
  streamerPage: { handle: string; name: string; about: string; url: string } | null;
  streamerApplication: {
    links: string[];
    note: string;
    status: string;
    createdAt: string;
    updatedAt: string;
    reviewedAt: string | null;
  } | null;
  entries: {
    id: string;
    streamerHandle: string;
    kind: string;
    title: string;
    body: string;
    category: string;
    options: string[];
    createdAt: string;
    endsAt: string | null;
    revealed: boolean;
    url: string;
  }[];
  comments: {
    id: string;
    entryId: string;
    entryTitle: string;
    streamerHandle: string;
    text: string;
    createdAt: string;
    parentId: string | null;
  }[];
  reactions: { entryId: string; entryTitle: string; streamerHandle: string; reaction: "like" | "dislike" }[];
  votes: { entryId: string; entryTitle: string; streamerHandle: string; choice: number; option: string | null }[];
  commentLikes: { commentId: string; entryId: string; entryTitle: string; streamerHandle: string }[];
  reports: {
    targetKind: string;
    targetId: string;
    reason: string;
    details: string;
    status: string;
    createdAt: string;
    resolvedAt: string | null;
  }[];
  images: ImageRecord[];
  legacyPolls: {
    votes: { pollId: string; choice: number }[];
    reactions: { pollId: string; value: number }[];
    comments: { id: string; pollId: string; text: string; createdAt: string }[];
  };
}

export const DELETED_AUTHOR_SNAPSHOT = "[Removed: the author deleted their account.]";

interface ReportRow extends PagedRow {
  target_kind: string;
  target_id: string;
  reason: string;
  details: string;
  status: string;
  created_at: number;
  resolved_at: number | null;
}

function iso(value: number): string {
  return new Date(value).toISOString();
}

function optionalIso(value: number | null): string | null {
  return value === null ? null : iso(value);
}

/** Reads every row for one user in rowid order, one bounded page per query. */
async function readAll<T extends PagedRow>(env: AppEnv, sql: string, userId: string): Promise<T[]> {
  const rows: T[] = [];
  let cursor = 0;
  for (;;) {
    const { results } = await env.DB.prepare(sql).bind(userId, cursor, EXPORT_PAGE_SIZE).all<T>();
    rows.push(...results);
    const last = results.at(-1);
    if (!last || results.length < EXPORT_PAGE_SIZE) return rows;
    cursor = last.row_cursor;
  }
}

async function imageRecords(env: AppEnv, userId: string, origin: string): Promise<ImageRecord[]> {
  const records: ImageRecord[] = [];
  for (const kind of ["avatar", "background"] as const) {
    const key = `${kind}/${userId}`;
    const object = await env.IMAGES.head(key);
    if (object) {
      records.push({
        kind,
        url: `${origin}/images/${kind}/${encodeURIComponent(userId)}`,
        contentType: object.httpMetadata?.contentType ?? null,
        bytes: object.size,
        uploadedAt: object.uploaded.toISOString(),
      });
    }
  }
  return records;
}

const entryJoin = "JOIN entries e ON e.id=x.entry_id JOIN streamers s ON s.id=e.streamer_id";
const page = "x.rowid>?2 ORDER BY x.rowid LIMIT ?3";

/** Reads the paged history tables for one account. */
async function readHistory(env: AppEnv, userId: string, now: number) {
  const providers = await readAll<ProviderRow>(
    env,
    `SELECT x.rowid AS row_cursor,x.provider_id,x.account_id,x.created_at,x.updated_at FROM account x WHERE x.user_id=?1 AND ${page}`,
    userId,
  );
  const sessions = (
    await readAll<SessionRow>(
      env,
      `SELECT x.rowid AS row_cursor,x.created_at,x.expires_at,x.ip_address,x.user_agent FROM session x WHERE x.user_id=?1 AND ${page}`,
      userId,
    )
  ).filter((row: SessionRow): boolean => row.expires_at > now);
  const entries = await readAll<EntryRow>(
    env,
    `SELECT x.rowid AS row_cursor,x.id,s.handle,x.kind,x.title,x.body,x.category,x.options,x.created_at,x.ends_at,x.revealed
      FROM entries x JOIN streamers s ON s.id=x.streamer_id WHERE x.author_id=?1 AND ${page}`,
    userId,
  );
  const comments = await readAll<CommentRow>(
    env,
    `SELECT x.rowid AS row_cursor,x.id,x.entry_id,e.title AS entry_title,s.handle,x.text,x.created_at,x.parent_id
      FROM entry_comments x ${entryJoin} WHERE x.author_id=?1 AND ${page}`,
    userId,
  );
  const reactions = await readAll<ReactionRow>(
    env,
    `SELECT x.rowid AS row_cursor,x.entry_id,e.title AS entry_title,s.handle,x.value
      FROM entry_reactions x ${entryJoin} WHERE x.user_id=?1 AND ${page}`,
    userId,
  );
  const votes = await readAll<VoteRow>(
    env,
    `SELECT x.rowid AS row_cursor,x.entry_id,e.title AS entry_title,s.handle,x.choice,
        json_extract(e.options,'$['||x.choice||']') AS option
      FROM entry_votes x ${entryJoin} WHERE x.user_id=?1 AND ${page}`,
    userId,
  );
  const likes = await readAll<LikeRow>(
    env,
    `SELECT x.rowid AS row_cursor,x.comment_id,c.entry_id,e.title AS entry_title,s.handle
      FROM comment_likes x JOIN entry_comments c ON c.id=x.comment_id JOIN entries e ON e.id=c.entry_id
      JOIN streamers s ON s.id=e.streamer_id WHERE x.user_id=?1 AND ${page}`,
    userId,
  );
  const reports = await readAll<ReportRow>(
    env,
    `SELECT x.rowid AS row_cursor,x.target_kind,x.target_id,x.reason,x.details,x.status,x.created_at,x.resolved_at
      FROM content_reports x WHERE x.reporter_id=?1 AND ${page}`,
    userId,
  );
  const legacyVotes = await readAll<LegacyVoteRow>(
    env,
    `SELECT x.rowid AS row_cursor,x.poll_id,x.choice FROM poll_votes x WHERE x.user_id=?1 AND ${page}`,
    userId,
  );
  const legacyReactions = await readAll<LegacyReactionRow>(
    env,
    `SELECT x.rowid AS row_cursor,x.poll_id,x.value FROM poll_reactions x WHERE x.user_id=?1 AND ${page}`,
    userId,
  );
  const legacyComments = await readAll<LegacyCommentRow>(
    env,
    `SELECT x.rowid AS row_cursor,x.id,x.poll_id,x.text,x.created_at FROM poll_comments x WHERE x.user_id=?1 AND ${page}`,
    userId,
  );
  return {
    providers,
    sessions,
    entries,
    comments,
    reactions,
    votes,
    likes,
    reports,
    legacyVotes,
    legacyReactions,
    legacyComments,
  };
}

/** Collects everything stored about the account. Credentials and other people's data are excluded. */
export async function exportAccount(env: AppEnv, userId: string): Promise<AccountExport> {
  const origin = getOrigin(env);
  const now = Date.now();
  const [userResult, streamerResult, applicationResult] = await env.DB.batch([
    env.DB.prepare("SELECT id,name,email,email_verified,image,created_at,updated_at FROM user WHERE id=?").bind(userId),
    env.DB.prepare("SELECT id,handle,name,about,avatar,background FROM streamers WHERE owner_id=?").bind(userId),
    env.DB.prepare(
      "SELECT links,note,status,created_at,updated_at,reviewed_at FROM streamer_applications WHERE user_id=?",
    ).bind(userId),
  ]);
  const account = userResult.results[0] as UserRow | undefined;
  if (!account) throw new HttpError(404, "Account not found.");
  const streamer = streamerResult.results[0] as StreamerRow | undefined;
  const application = applicationResult.results[0] as ApplicationRow | undefined;

  const history = await readHistory(env, userId, now);

  return {
    exportedAt: iso(now),
    notes: NOTES,
    account: {
      id: account.id,
      name: account.name,
      email: account.email,
      emailVerified: account.email_verified === 1,
      image: account.image,
      createdAt: iso(account.created_at),
      updatedAt: iso(account.updated_at),
    },
    signInMethods: history.providers.map((row: ProviderRow) => ({
      providerId: row.provider_id,
      accountId: row.account_id,
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
    })),
    activeSessions: history.sessions.map((row: SessionRow) => ({
      createdAt: iso(row.created_at),
      expiresAt: iso(row.expires_at),
      ipAddress: row.ip_address,
      userAgent: row.user_agent,
    })),
    streamerPage: streamer
      ? { handle: streamer.handle, name: streamer.name, about: streamer.about, url: `${origin}/@${streamer.handle}` }
      : null,
    streamerApplication: application
      ? {
          links: JSON.parse(application.links) as string[],
          note: application.note,
          status: application.status,
          createdAt: iso(application.created_at),
          updatedAt: iso(application.updated_at),
          reviewedAt: optionalIso(application.reviewed_at),
        }
      : null,
    entries: history.entries.map((row: EntryRow) => ({
      id: row.id,
      streamerHandle: row.handle,
      kind: row.kind,
      title: row.title,
      body: row.body,
      category: row.category,
      options: JSON.parse(row.options) as string[],
      createdAt: iso(row.created_at),
      endsAt: optionalIso(row.ends_at),
      revealed: row.revealed === 1,
      url: `${origin}/@${row.handle}`,
    })),
    comments: history.comments.map((row: CommentRow) => ({
      id: row.id,
      entryId: row.entry_id,
      entryTitle: row.entry_title,
      streamerHandle: row.handle,
      text: row.text,
      createdAt: iso(row.created_at),
      parentId: row.parent_id,
    })),
    reactions: history.reactions.map((row: ReactionRow) => ({
      entryId: row.entry_id,
      entryTitle: row.entry_title,
      streamerHandle: row.handle,
      reaction: row.value === 1 ? ("like" as const) : ("dislike" as const),
    })),
    votes: history.votes.map((row: VoteRow) => ({
      entryId: row.entry_id,
      entryTitle: row.entry_title,
      streamerHandle: row.handle,
      choice: row.choice,
      option: row.option,
    })),
    commentLikes: history.likes.map((row: LikeRow) => ({
      commentId: row.comment_id,
      entryId: row.entry_id,
      entryTitle: row.entry_title,
      streamerHandle: row.handle,
    })),
    reports: history.reports.map((row: ReportRow) => ({
      targetKind: row.target_kind,
      targetId: row.target_id,
      reason: row.reason,
      details: row.details,
      status: row.status,
      createdAt: iso(row.created_at),
      resolvedAt: optionalIso(row.resolved_at),
    })),
    images: await imageRecords(env, userId, origin),
    legacyPolls: {
      votes: history.legacyVotes.map((row: LegacyVoteRow) => ({ pollId: row.poll_id, choice: row.choice })),
      reactions: history.legacyReactions.map((row: LegacyReactionRow) => ({ pollId: row.poll_id, value: row.value })),
      comments: history.legacyComments.map((row: LegacyCommentRow) => ({
        id: row.id,
        pollId: row.poll_id,
        text: row.text,
        createdAt: iso(row.created_at),
      })),
    },
  };
}

// Streamer pages (other than the user's own) whose public counts or lists change when the user's rows go.
const touchedStreamers = `
  SELECT e.streamer_id FROM entries e WHERE e.author_id=?1
  UNION SELECT e.streamer_id FROM entry_votes v JOIN entries e ON e.id=v.entry_id WHERE v.user_id=?1
  UNION SELECT e.streamer_id FROM entry_reactions r JOIN entries e ON e.id=r.entry_id WHERE r.user_id=?1
  UNION SELECT e.streamer_id FROM entry_comments c JOIN entries e ON e.id=c.entry_id WHERE c.author_id=?1
  UNION SELECT e.streamer_id FROM comment_likes l JOIN entry_comments c ON c.id=l.comment_id
    JOIN entries e ON e.id=c.entry_id WHERE l.user_id=?1`;

/**
 * Permanently deletes the account and everything it owns in one atomic D1 batch.
 * Foreign keys cascade from `user` to sessions, sign-in links, the streamer page and its entries,
 * the user's entries, comments, votes, reactions, likes, and waitlist application.
 * Replies other people wrote under the user's comments are kept as top-level comments.
 * Uploaded images are removed after the database commit, then affected live rooms are refreshed.
 */
export async function deleteAccount(env: AppEnv, userId: string): Promise<void> {
  const statement = (sql: string): D1PreparedStatement => env.DB.prepare(sql).bind(userId);
  const results = await env.DB.batch([
    statement("SELECT id FROM streamers WHERE owner_id=?1"),
    statement(
      `UPDATE streamers SET revision=revision+1 WHERE owner_id<>?1 AND id IN (${touchedStreamers}) RETURNING id`,
    ),
    statement(
      "UPDATE entry_comments SET parent_id=NULL WHERE author_id<>?1 AND parent_id IN (SELECT id FROM entry_comments WHERE author_id=?1)",
    ),
    statement("DELETE FROM app_rate_limits WHERE key IN ('write:'||?1,'content:'||?1)"),
    statement(
      `DELETE FROM verification WHERE identifier IN (?1,(SELECT email FROM user WHERE id=?1))
        OR instr(value,'"userId":"'||?1||'"')>0`,
    ),
    // Reports the user made are their personal data. Reports about the user's content keep the
    // moderation record, but the copied text goes because the content itself is being erased.
    statement("DELETE FROM content_reports WHERE reporter_id=?1"),
    statement(
      `UPDATE content_reports SET snapshot='${DELETED_AUTHOR_SNAPSHOT}'
        WHERE target_author_id=?1`,
    ),
    statement("DELETE FROM poll_votes WHERE user_id=?1"),
    statement("DELETE FROM poll_reactions WHERE user_id=?1"),
    statement("DELETE FROM poll_comments WHERE user_id=?1"),
    statement("DELETE FROM user WHERE id=?1 RETURNING id"),
  ]);
  if (results.at(-1)?.results.length !== 1) throw new HttpError(404, "Account not found.");
  try {
    await env.IMAGES.delete([`avatar/${userId}`, `background/${userId}`]);
  } catch (error_: unknown) {
    // The account is already deleted, so the request still succeeds. Log the error class, not its
    // message, so operators can remove the leftover images without exposing storage details.
    console.error("account_image_delete_failed", { cause: error_ instanceof Error ? error_.name : "unknown" });
  }
  const streamerIds = [...results[0].results, ...results[1].results].map(
    (row: unknown): string => (row as { id: string }).id,
  );
  await Promise.all(streamerIds.map((id: string): Promise<void> => notifyRoom(env, id)));
}
