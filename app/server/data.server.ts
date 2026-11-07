import { and, asc, count, desc, eq, getTableColumns, gt, ne, or, sql, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";
import { streamers, user } from "../../db/schema";
import type { AppEnv } from "../env";
import type { Locale } from "../i18n";
import type {
  BoardSnapshot,
  DisplayPrefs,
  Entry,
  EntryKind,
  EntryStatus,
  LiveSnapshot,
  Reaction,
  Streamer,
  StreamerDirectory,
  StreamerStatus,
} from "../types";
import {
  assertStreamerWritable,
  canCreateStreamer,
  canViewStreamer,
  isAdmin,
  isStreamerVisible,
  streamerRole,
} from "./access.server";
import { IDEA_CATEGORIES, isUntouchedTemplate, NEW_IDEA_STATUS } from "../lib/ideas";
import { HttpError } from "./http.server";
import { MASH_COLUMN, mashValue } from "./mash-sql";
import {
  directoryQuerySchema,
  displayPrefsSchema,
  entryActionSchema,
  entryQuerySchema,
  localeSchema,
  profileSchema,
  streamerEditSchema,
  streamerSchema,
} from "./validation";
import type { DirectoryQuery, EntryAction, EntryQuery, ProfileInput, StreamerEdit, StreamerInput } from "./validation";

const PAGE_SIZE = 50;
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
  status: EntryStatus | null;
  status_reason: string | null;
  reported: number;
  mash: string | null;
}
interface PermissionRow {
  id: string;
  streamer_id: string;
  author_id: string;
  owner_id: string;
  kind: EntryKind;
}

export function parsed<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new HttpError(400, result.error.issues[0]?.message ?? "Invalid input.");
  return result.data;
}

export function publicAvatar(id: string, value: string | null): string | null {
  return value === `/images/avatar/${encodeURIComponent(id)}` ? value : null;
}

export function decodeCursor(value: string | null, scope: string, sort: "newest" | "top", query = ""): Cursor | null {
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

export function encodeCursor(cursor: Cursor): string {
  const bytes = new TextEncoder().encode(JSON.stringify(cursor));
  return btoa(Array.from(bytes, (byte: number): string => String.fromCodePoint(byte)).join(""))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

const HANDLE_CHANGE_INTERVAL = 30 * 86_400_000;

function ownedImage(kind: "background" | "logo", ownerId: string, value: string | null): string | null {
  return value === `/images/${kind}/${encodeURIComponent(ownerId)}` ? value : null;
}

/**
 * Shapes a page for the API. `privileged` (the owner, or an admin on a moderated page) adds the
 * moderation reason and the last handle change.
 */
/** A streamers row with the owner's preset avatar, which the page logo falls back to (item 18). */
type StreamerRow = typeof streamers.$inferSelect & { ownerAvatarPreset?: number | null };

/** Every streamers column plus the owner's `avatar_preset`. */
const streamerColumns = {
  ...getTableColumns(streamers),
  ownerAvatarPreset: sql<number | null>`(SELECT avatar_preset FROM user WHERE user.id = ${streamers.ownerId})`,
};

function streamerValue(row: StreamerRow, privileged = false): Streamer {
  const preset = row.ownerAvatarPreset;
  return {
    id: row.id,
    ownerId: row.ownerId,
    handle: row.handle,
    name: row.name,
    about: row.about,
    avatar: publicAvatar(row.ownerId, row.avatar),
    background: ownedImage("background", row.ownerId, row.background),
    logo: ownedImage("logo", row.ownerId, row.logo),
    ownerAvatarPreset: typeof preset === "number" && preset >= 0 && preset <= 17 ? preset : null,
    isOfficial: row.isOfficial,
    status: row.status,
    statusReason: privileged ? row.statusReason : null,
    handleChangedAt: privileged ? row.handleChangedAt : null,
  };
}

function directoryCursor(value: string | null): { official: boolean; handle: string } | null {
  if (value === null) return null;
  // Plain handles are cursors from before official pages existed; they always sit after official pages.
  const match = /^(?:([01])\.)?([a-z0-9_]{3,30})$/u.exec(value);
  if (!match) throw new HttpError(400, "Invalid page cursor.");
  return { official: match[1] === "1", handle: match[2] };
}

/** Pages the public directory lists: not suspended, and matching `query` by name or handle. */
function directoryFilter(query: string): SQL | undefined {
  const pattern = `%${query.replaceAll(/[\\%_]/gu, String.raw`\$&`)}%`;
  return and(
    ne(streamers.status, "suspended"),
    query
      ? sql`(${streamers.name} LIKE ${pattern} ESCAPE '\\' OR ${streamers.handle} LIKE ${pattern} ESCAPE '\\')`
      : undefined,
  );
}

/** How many pages the directory lists for `query` ("Showing 8 of 10 pages"). */
export async function countStreamers(env: AppEnv, query: DirectoryQuery["query"] = ""): Promise<number> {
  const input = parsed(directoryQuerySchema, { query });
  const [row] = await drizzle(env.DB).select({ total: count() }).from(streamers).where(directoryFilter(input.query));
  return row?.total ?? 0;
}

/**
 * The public directory: official pages first, then by handle. Suspended pages are left out.
 * `query` matches the page name or handle. The cursor is the last handle, prefixed `1.` while the
 * page is still in the official group.
 */
export async function listStreamers(
  env: AppEnv,
  cursor: string | null = null,
  query: DirectoryQuery["query"] = "",
): Promise<StreamerDirectory> {
  const input = parsed(directoryQuerySchema, { cursor, query });
  const after = directoryCursor(input.cursor);
  const rows = await drizzle(env.DB)
    .select(streamerColumns)
    .from(streamers)
    .where(
      and(
        directoryFilter(input.query),
        after === null
          ? undefined
          : after.official
            ? or(
                eq(streamers.isOfficial, false),
                and(eq(streamers.isOfficial, true), gt(streamers.handle, after.handle)),
              )
            : and(eq(streamers.isOfficial, false), gt(streamers.handle, after.handle)),
      ),
    )
    .orderBy(desc(streamers.isOfficial), asc(streamers.handle))
    .limit(PAGE_SIZE + 1);
  const page = rows.slice(0, PAGE_SIZE);
  const last = page.at(-1);
  return {
    streamers: page.map((row) => streamerValue(row)),
    nextCursor: rows.length > PAGE_SIZE && last ? `${last.isOfficial ? "1." : ""}${last.handle}` : null,
  };
}

async function streamerRow(env: AppEnv, handle: string): Promise<StreamerRow | null> {
  if (!/^[a-z0-9_]{3,30}$/u.test(handle)) return null;
  const [row] = await drizzle(env.DB)
    .select(streamerColumns)
    .from(streamers)
    .where(eq(streamers.handle, handle))
    .limit(1);
  return row ?? null;
}

/**
 * Any page by handle, whatever its status. Use it only where status is enforced separately
 * (writes go through assertStreamerWritable); everything a viewer reads goes through getVisibleStreamer.
 */
export async function getStreamer(env: AppEnv, handle: string): Promise<Streamer | null> {
  const row = await streamerRow(env, handle);
  return row ? streamerValue(row) : null;
}

/** A page as the viewer may see it: null when it does not exist or is suspended and the viewer is not its owner or an admin. */
export async function getVisibleStreamer(
  env: AppEnv,
  handle: string,
  viewerId: string | null,
): Promise<Streamer | null> {
  const row = await streamerRow(env, handle);
  if (!row) return null;
  const owner = viewerId !== null && row.ownerId === viewerId;
  if (row.status === "active") return streamerValue(row, owner);
  const role = await streamerRole(env, row, viewerId);
  if (!isStreamerVisible(row.status, role)) return null;
  return streamerValue(row, role.owner || role.admin);
}

export async function getOwnStreamer(env: AppEnv, userId: string): Promise<Streamer | null> {
  const [row] = await drizzle(env.DB)
    .select(streamerColumns)
    .from(streamers)
    .where(eq(streamers.ownerId, userId))
    .limit(1);
  return row ? streamerValue(row, true) : null;
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

function handleConflict(error: unknown): never {
  let message = "";
  if (error instanceof Error) {
    const causeMessage = error.cause instanceof Error ? error.cause.message : "";
    message = `${error.message} ${causeMessage}`;
  }
  if (message.includes("UNIQUE constraint failed: streamers.handle"))
    throw new HttpError(409, "This handle is already in use.");
  throw error;
}

/**
 * A handle can change once every 30 days (R11). Old links and the overlay URL stop working; there
 * are no redirects. Returns the new `handle_changed_at`, or the current one when the handle is unchanged.
 */
function handleChange(current: typeof streamers.$inferSelect, handle: string | undefined, now: number): number | null {
  if (handle === undefined || handle === current.handle) return current.handleChangedAt;
  if (current.handleChangedAt !== null && now - current.handleChangedAt < HANDLE_CHANGE_INTERVAL) {
    const next = new Date(current.handleChangedAt + HANDLE_CHANGE_INTERVAL).toISOString().slice(0, 10);
    throw new HttpError(409, `You can change your handle once every 30 days. Try again on ${next}.`);
  }
  return now;
}

async function ownerAvatarPreset(env: AppEnv, userId: string): Promise<number | null> {
  const [row] = await drizzle(env.DB)
    .select({ preset: user.avatarPreset })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  return row?.preset ?? null;
}

async function ownStreamerRow(env: AppEnv, userId: string): Promise<typeof streamers.$inferSelect | null> {
  const [row] = await drizzle(env.DB).select().from(streamers).where(eq(streamers.ownerId, userId)).limit(1);
  return row ?? null;
}

/** Creates the account's page, or replaces its handle, name and about (the original settings form). */
export async function saveStreamer(env: AppEnv, userId: string, input: StreamerInput): Promise<Streamer> {
  const value = parsed(streamerSchema, input);
  await consumeMutationQuota(env, userId);
  const [account] = await drizzle(env.DB).select({ image: user.image }).from(user).where(eq(user.id, userId)).limit(1);
  if (!account) throw new HttpError(401, "Sign in to create a streamer profile.");
  const current = await ownStreamerRow(env, userId);
  if (current) await assertStreamerWritable(env, current.id, userId);
  else if (!(await canCreateStreamer(env, userId)))
    throw new HttpError(403, "Streamer profiles need approval. Join the streamer waitlist first.");
  const avatar = publicAvatar(userId, account.image);
  const handleChangedAt = current ? handleChange(current, value.handle, Date.now()) : null;
  try {
    const [row] = await drizzle(env.DB)
      .insert(streamers)
      .values({ id: crypto.randomUUID(), ownerId: userId, ...value, avatar })
      .onConflictDoUpdate({
        target: streamers.ownerId,
        set: { ...value, avatar, handleChangedAt },
      })
      .returning();
    if (!row) throw new Error("Streamer profile was not saved.");
    return streamerValue({ ...row, ownerAvatarPreset: await ownerAvatarPreset(env, userId) }, true);
  } catch (error: unknown) {
    return handleConflict(error);
  }
}

/**
 * `PATCH /api/streamer` ("Edit your page", item 18): changes only the fields sent.
 * `logoMode: "profile"` drops the uploaded logo so the page shows the owner's picture again;
 * `logoMode: "logo"` keeps the uploaded logo and needs one (upload it with `PUT /api/images/logo`).
 */
export async function updateStreamer(env: AppEnv, userId: string, input: StreamerEdit): Promise<Streamer> {
  const value = parsed(streamerEditSchema, input);
  const current = await ownStreamerRow(env, userId);
  if (!current) throw new HttpError(404, "Create your streamer page first.");
  await assertStreamerWritable(env, current.id, userId);
  await consumeMutationQuota(env, userId);
  if (value.logoMode === "logo" && !current.logo) throw new HttpError(400, "Upload a logo first.");
  const handleChangedAt = handleChange(current, value.handle, Date.now());
  const set: Partial<typeof streamers.$inferInsert> = { handleChangedAt };
  if (value.name !== undefined) set.name = value.name;
  if (value.about !== undefined) set.about = value.about;
  if (value.handle !== undefined) set.handle = value.handle;
  if (value.logoMode === "profile") set.logo = null;
  let row: typeof streamers.$inferSelect | undefined;
  try {
    [row] = await drizzle(env.DB).update(streamers).set(set).where(eq(streamers.id, current.id)).returning();
  } catch (error: unknown) {
    handleConflict(error);
  }
  if (!row) throw new HttpError(404, "Create your streamer page first.");
  if (value.logoMode === "profile" && current.logo) await env.IMAGES.delete(`logo/${userId}`);
  return streamerValue({ ...row, ownerAvatarPreset: await ownerAvatarPreset(env, userId) }, true);
}

/** `PATCH /api/profile`: the display name and preset avatar. A preset does not remove an uploaded picture. */
export async function updateProfile(
  env: AppEnv,
  userId: string,
  input: ProfileInput,
): Promise<{ name: string; avatarPreset: number | null }> {
  const value = parsed(profileSchema, input);
  await consumeMutationQuota(env, userId);
  const set: Partial<typeof user.$inferInsert> = { updatedAt: new Date() };
  if (value.name !== undefined) set.name = value.name;
  if (value.avatarPreset !== undefined) set.avatarPreset = value.avatarPreset;
  const [row] = await drizzle(env.DB)
    .update(user)
    .set(set)
    .where(eq(user.id, userId))
    .returning({ name: user.name, avatarPreset: user.avatarPreset });
  if (!row) throw new HttpError(401, "Sign in to continue.");
  return row;
}

/** `PATCH /api/me/locale`. Null forgets the saved language. */
export async function setLocale(env: AppEnv, userId: string, input: unknown): Promise<Locale | null> {
  const { locale } = parsed(localeSchema, input);
  await consumeMutationQuota(env, userId);
  await drizzle(env.DB).update(user).set({ locale, updatedAt: new Date() }).where(eq(user.id, userId));
  return locale;
}

/** `PATCH /api/me/preferences`. Replaces the saved preferences; the client debounces by one second. */
export async function setDisplayPrefs(env: AppEnv, userId: string, input: unknown): Promise<DisplayPrefs> {
  const preferences = parsed(displayPrefsSchema, input);
  await consumeMutationQuota(env, userId);
  await drizzle(env.DB)
    .update(user)
    .set({ displayPrefs: JSON.stringify(preferences), updatedAt: new Date() })
    .where(eq(user.id, userId));
  return preferences;
}

const entrySelect = `
  SELECT e.*, u.name AS author, u.image AS avatar,
    (SELECT count(*) FROM entry_reactions r WHERE r.entry_id=e.id AND r.value=1) AS likes,
    (SELECT count(*) FROM entry_reactions r WHERE r.entry_id=e.id AND r.value=-1) AS dislikes,
    (SELECT count(*) FROM entry_comments c WHERE c.entry_id=e.id AND c.removed_at IS NULL) AS comments,
    (SELECT json_group_array(json_object('choice',choice,'count',n)) FROM
      (SELECT choice,count(*) AS n FROM entry_votes v WHERE v.entry_id=e.id GROUP BY choice)) AS vote_counts,
    COALESCE((SELECT value FROM entry_reactions r WHERE r.entry_id=e.id AND r.user_id=?),0) AS reaction,
    (SELECT choice FROM entry_votes v WHERE v.entry_id=e.id AND v.user_id=?) AS my_vote,
    COALESCE((SELECT sum(value) FROM entry_reactions r WHERE r.entry_id=e.id),0) AS score,
    EXISTS(SELECT 1 FROM content_reports cr WHERE cr.target_kind='entry' AND cr.target_id=e.id
      AND cr.reporter_id=? AND cr.status='open') AS reported,
    ${MASH_COLUMN}
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
  const mash = mashValue(row.mash, options.length);
  return {
    id: row.id,
    streamerId: row.streamer_id,
    authorId: row.author_id,
    author: row.author,
    avatar: publicAvatar(row.author_id, row.avatar),
    kind: mash ? "mash" : row.kind,
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
    status: row.status ?? null,
    statusReason: row.status_reason ?? null,
    reported: row.reported === 1,
    mash,
  };
}

export async function getEntry(env: AppEnv, id: string, viewerId: string | null): Promise<Entry | null> {
  const row = await env.DB.prepare(`${entrySelect} WHERE e.id=?`)
    .bind(viewerId ?? "", viewerId ?? "", viewerId ?? "", id)
    .first<EntryRow>();
  return row ? entryValue(row) : null;
}

/** A topic or poll, or null when it does not exist or its page is suspended and hidden from the viewer. */
export async function getVisibleEntry(env: AppEnv, id: string, viewerId: string | null): Promise<Entry | null> {
  const entry = await getEntry(env, id, viewerId);
  if (!entry) return null;
  const page = await env.DB.prepare("SELECT owner_id, status FROM streamers WHERE id=?")
    .bind(entry.streamerId)
    .first<{ owner_id: string; status: StreamerStatus }>();
  if (!page) return null;
  return (await canViewStreamer(env, { ownerId: page.owner_id, status: page.status }, viewerId)) ? entry : null;
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
    pollId === null ? ["", "", "", streamerId, streamerId, streamerId] : ["", "", "", pollId, streamerId];
  const results = await env.DB.batch([
    env.DB.prepare("SELECT revision, status FROM streamers WHERE id=?").bind(streamerId),
    env.DB.prepare(`${entrySelect} WHERE e.id=${selection} AND e.streamer_id=? AND e.kind!='topic'`).bind(
      ...parameters,
    ),
  ]);
  const page = results[0]?.results[0] as { revision: number; status: string } | undefined;
  if (page === undefined) throw new HttpError(404, "Streamer not found.");
  const { revision } = page;
  // A suspended page shows nothing in the overlay.
  const rows = page.status === "suspended" ? [] : (results[1].results as unknown as EntryRow[]);
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
        mash: entry.mash,
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
  const scope = `${streamer.id}:${query.kind}${query.status ? `:${query.status}` : ""}`;
  const cursor = decodeCursor(query.cursor, scope, query.sort, query.query);
  const escapedQuery = query.query.replaceAll(/[\\%_]/gu, String.raw`\$&`);
  const parameters: (string | number)[] = [
    viewerId ?? "",
    viewerId ?? "",
    viewerId ?? "",
    streamer.id,
    `%${escapedQuery}%`,
    query.status ?? "",
    query.status ?? "",
  ];
  let where = "";
  if (cursor) {
    where = query.sort === "top" ? "WHERE (score,created_at,id) < (?,?,?)" : "WHERE (created_at,id) < (?,?)";
    if (query.sort === "top") parameters.push(cursor.score);
    parameters.push(cursor.time, cursor.id);
  }
  const entriesQuery = env.DB.prepare(String.raw`SELECT * FROM (${entrySelect}
    WHERE e.streamer_id=? AND e.kind ${query.kind === "topics" ? "= 'topic'" : "!= 'topic'"}
      AND e.title LIKE ? ESCAPE '\' AND (?='' OR e.status=?)) ${where}
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

export async function applyMutation(
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

/**
 * Authors and the streamer may remove their content. Administrators may remove anything for moderation.
 * Returns whether the removal relies on administrator rights.
 */
export async function removalByAdmin(
  env: AppEnv,
  viewerId: string,
  authorId: string,
  ownerId: string,
  denied: string,
): Promise<boolean> {
  if (authorId === viewerId || ownerId === viewerId) return false;
  if (await isAdmin(env, viewerId)) return true;
  throw new HttpError(403, denied);
}

async function removeEntry(env: AppEnv, viewerId: string, permission: PermissionRow): Promise<void> {
  const admin = await removalByAdmin(
    env,
    viewerId,
    permission.author_id,
    permission.owner_id,
    "Only the author or streamer can remove this item.",
  );
  if (!admin && permission.owner_id !== viewerId) {
    // Ideas board: the author may delete their idea only while it is still under review.
    const idea = await env.DB.prepare(
      "SELECT s.is_official, e.status FROM entries e JOIN streamers s ON s.id=e.streamer_id WHERE e.id=?",
    )
      .bind(permission.id)
      .first<{ is_official: number; status: EntryStatus | null }>();
    if (idea?.is_official === 1 && idea.status !== null && idea.status !== NEW_IDEA_STATUS)
      throw new HttpError(403, "You can delete your idea only while it is under review.");
  }
  await applyMutation(
    env,
    permission.streamer_id,
    env.DB.prepare(`DELETE FROM entries WHERE id=? AND streamer_id=?
    AND (?=1 OR author_id=? OR EXISTS(SELECT 1 FROM streamers s WHERE s.id=entries.streamer_id AND s.owner_id=?))`).bind(
      permission.id,
      permission.streamer_id,
      admin ? 1 : 0,
      viewerId,
      viewerId,
    ),
    404,
    "Topic or poll not found.",
  );
}

/** Removes a topic or poll with the same rules as a delete action, without consuming the caller's quota. */
export async function deleteEntry(env: AppEnv, viewerId: string, streamerId: string, id: string): Promise<void> {
  await removeEntry(env, viewerId, await entryPermission(env, id, streamerId));
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
  let status: EntryStatus | null = null;
  if (action.kind === "topic") {
    const page = await env.DB.prepare("SELECT is_official FROM streamers WHERE id=?")
      .bind(streamerId)
      .first<{ is_official: number }>();
    const official = page?.is_official === 1;
    const category = action.category ?? "";
    // The official page is the Ideas board (item 46): its own categories, and every new idea starts under review.
    if (official !== (IDEA_CATEGORIES as readonly string[]).includes(category))
      throw new HttpError(400, official ? "Pick a category for your idea." : "Pick a topic category.");
    if (official && category === "bug" && isUntouchedTemplate(action.body ?? ""))
      throw new HttpError(400, "Describe the bug: fill in what happened and how to reproduce it.");
    if (official) status = NEW_IDEA_STATUS;
  }
  await applyMutation(
    env,
    streamerId,
    env.DB.prepare(`
    INSERT INTO entries (id,streamer_id,author_id,kind,title,body,category,options,created_at,ends_at,revealed,status)
    SELECT ?,s.id,?,?,?,?,?,?,?,?,0,? FROM streamers s WHERE s.id=? AND (?='topic' OR s.owner_id=?)
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
      status,
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
  await assertStreamerWritable(env, streamerId, viewerId, { moderation: action.action === "delete" });
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
          AND NOT EXISTS(SELECT 1 FROM entry_mash m WHERE m.entry_id=entries.id AND m.phase!='setup')
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
      await removeEntry(env, viewerId, permission);
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
