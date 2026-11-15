import type { z } from "zod";
import type { AppEnv } from "../env";
import type {
  ApplicationQueue,
  ApplicationReviewItem,
  ApplicationStatus,
  StreamerAccess,
  StreamerApplication,
  StreamerStatus,
} from "../types";
import { HttpError } from "./http.server";
import {
  applicationQuerySchema,
  applicationReviewSchema,
  applicationSchema,
  type ApplicationInput,
  type ApplicationQuery,
  type ApplicationReview,
  isPlaceholderEmail,
} from "./validation";

const QUEUE_PAGE_SIZE = 50;

interface ApplicationRow {
  id: string;
  user_id: string;
  links: string;
  note: string;
  status: ApplicationStatus;
  created_at: number;
  updated_at: number;
  reviewed_at: number | null;
}

interface ReviewRow extends ApplicationRow {
  name: string;
  email: string;
}

function parsed<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new HttpError(400, result.error.issues[0]?.message ?? "Invalid input.");
  return result.data;
}

// Parses the operator-managed admin list. Entries are separated by commas or whitespace.
export function adminEmails(env: AppEnv): Set<string> {
  return new Set(
    (env.ADMIN_EMAILS ?? "")
      .split(/[\s,]+/u)
      .map((email: string): string => email.trim().toLowerCase())
      .filter((email: string): boolean => email.includes("@")),
  );
}

// An admin has a verified email address that the operator lists in ADMIN_EMAILS.
export async function isAdmin(env: AppEnv, userId: string): Promise<boolean> {
  const admins = adminEmails(env);
  if (admins.size === 0) return false;
  const row = await env.DB.prepare("SELECT email, email_verified FROM user WHERE id=?")
    .bind(userId)
    .first<{ email: string; email_verified: number }>();
  return Boolean(row?.email_verified === 1 && admins.has(row.email.toLowerCase()));
}

export async function requireAdmin(env: AppEnv, userId: string): Promise<void> {
  if (!(await isAdmin(env, userId))) throw new HttpError(403, "Only administrators can review applications.");
}

// Active: public/writable. Frozen: public/read-only, including owners. Suspended: owner/admin reads only;
// directory/overlay/live hidden. Admin content removal remains allowed.
export interface StreamerState {
  id: string;
  ownerId: string;
  status: StreamerStatus;
}

export interface StreamerRole {
  owner: boolean;
  admin: boolean;
}

export function isStreamerWritable(status: StreamerStatus): boolean {
  return status === "active";
}

export function isStreamerVisible(status: StreamerStatus, role: StreamerRole): boolean {
  return status !== "suspended" || role.owner || role.admin;
}

// Directory, overlay, and live-room visibility.
export function isStreamerListed(status: StreamerStatus): boolean {
  return status !== "suspended";
}

async function streamerState(env: AppEnv, streamerId: string): Promise<StreamerState | null> {
  const row = await env.DB.prepare("SELECT id, owner_id, status FROM streamers WHERE id=?")
    .bind(streamerId)
    .first<{ id: string; owner_id: string; status: StreamerStatus }>();
  return row ? { id: row.id, ownerId: row.owner_id, status: row.status } : null;
}

// Anonymous viewers have no owner/admin role.
export async function streamerRole(
  env: AppEnv,
  streamer: Pick<StreamerState, "ownerId">,
  viewerId: string | null,
): Promise<StreamerRole> {
  if (!viewerId) return { owner: false, admin: false };
  return { owner: streamer.ownerId === viewerId, admin: await isAdmin(env, viewerId) };
}

// Check admin rights only for suspended pages.
export async function canViewStreamer(
  env: AppEnv,
  streamer: Pick<StreamerState, "ownerId" | "status">,
  viewerId: string | null,
): Promise<boolean> {
  if (streamer.status !== "suspended") return true;
  return isStreamerVisible(streamer.status, await streamerRole(env, streamer, viewerId));
}

// Gate all page writes. Missing/hidden pages return 404; frozen/suspended pages return 423. `moderation: true`
// allows admin content removal only.
export async function assertStreamerWritable(
  env: AppEnv,
  streamerId: string,
  viewerId: string | null,
  options: { moderation?: boolean } = {},
): Promise<StreamerState> {
  const state = await streamerState(env, streamerId);
  if (!state) throw new HttpError(404, "Streamer not found.");
  if (isStreamerWritable(state.status)) return state;
  const role = await streamerRole(env, state, viewerId);
  if (!isStreamerVisible(state.status, role)) throw new HttpError(404, "Streamer not found.");
  if (options.moderation && role.admin) return state;
  throw new HttpError(
    423,
    state.status === "frozen"
      ? "This page is frozen. It stays visible, but nothing on it can change."
      : "This page is suspended. Nothing on it can change.",
  );
}

function applicationValue(row: ApplicationRow): StreamerApplication {
  return {
    id: row.id,
    links: JSON.parse(row.links) as string[],
    note: row.note,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    reviewedAt: row.reviewed_at,
  };
}

export async function getApplication(env: AppEnv, userId: string): Promise<StreamerApplication | null> {
  const row = await env.DB.prepare("SELECT * FROM streamer_applications WHERE user_id=?")
    .bind(userId)
    .first<ApplicationRow>();
  return row ? applicationValue(row) : null;
}

export async function getStreamerAccess(env: AppEnv, userId: string): Promise<StreamerAccess> {
  const [admin, application] = await Promise.all([isAdmin(env, userId), getApplication(env, userId)]);
  return { admin, application, canCreateStreamer: admin || application?.status === "approved" };
}

export async function canCreateStreamer(env: AppEnv, userId: string): Promise<boolean> {
  return (await getStreamerAccess(env, userId)).canCreateStreamer;
}

// Create/update pending or rejected applications. Resubmission resets rejection to pending; approved requests
// cannot change.
export async function submitApplication(
  env: AppEnv,
  userId: string,
  input: ApplicationInput,
): Promise<StreamerApplication> {
  const value = parsed(applicationSchema, input);
  const owned = await env.DB.prepare("SELECT 1 AS found FROM streamers WHERE owner_id=?")
    .bind(userId)
    .first<{ found: number }>();
  if (owned) throw new HttpError(409, "You already have a streamer profile.");
  const now = Date.now();
  const row = await env.DB.prepare(`
    INSERT INTO streamer_applications (id, user_id, links, note, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'pending', ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      links=excluded.links, note=excluded.note, status='pending', updated_at=excluded.updated_at,
      reviewed_at=NULL, reviewed_by=NULL
    WHERE streamer_applications.status <> 'approved'
    RETURNING *
  `)
    .bind(crypto.randomUUID(), userId, JSON.stringify(value.links), value.note, now, now)
    .first<ApplicationRow>();
  if (!row) throw new HttpError(409, "Your application is already approved. Create your streamer profile.");
  return applicationValue(row);
}

function decodeQueueCursor(value: string | null): { time: number; id: string } | null {
  if (value === null) return null;
  const match = /^(\d{1,15})\.([a-f0-9-]{36})$/u.exec(value);
  if (!match) throw new HttpError(400, "Invalid page cursor.");
  return { time: Number(match[1]), id: match[2] };
}

// Lists applications for review. Pending requests come oldest first; reviewed ones newest first.
export async function listApplications(env: AppEnv, query: ApplicationQuery): Promise<ApplicationQueue> {
  const value = parsed(applicationQuerySchema, query);
  const cursor = decodeQueueCursor(value.cursor);
  const ascending = value.status === "pending";
  const comparison = ascending ? ">" : "<";
  const direction = ascending ? "ASC" : "DESC";
  const bindings: (string | number)[] = [value.status];
  let where = "a.status=?";
  if (cursor) {
    where += ` AND (a.updated_at ${comparison} ? OR (a.updated_at = ? AND a.id ${comparison} ?))`;
    bindings.push(cursor.time, cursor.time, cursor.id);
  }
  const { results } = await env.DB.prepare(`
    SELECT a.*, u.name AS name, u.email AS email FROM streamer_applications a JOIN user u ON u.id=a.user_id
    WHERE ${where} ORDER BY a.updated_at ${direction}, a.id ${direction} LIMIT ?
  `)
    .bind(...bindings, QUEUE_PAGE_SIZE + 1)
    .all<ReviewRow>();
  const page = results.slice(0, QUEUE_PAGE_SIZE);
  const last = page.at(-1);
  return {
    applications: page.map(
      (row: ReviewRow): ApplicationReviewItem => ({
        ...applicationValue(row),
        userId: row.user_id,
        name: row.name,
        email: isPlaceholderEmail(row.email) ? "" : row.email,
      }),
    ),
    nextCursor: results.length > QUEUE_PAGE_SIZE && last ? `${last.updated_at}.${last.id}` : null,
  };
}

// Records an admin decision. Approval lets the applicant create one streamer profile.
export async function reviewApplication(
  env: AppEnv,
  reviewerId: string,
  input: ApplicationReview,
): Promise<StreamerApplication> {
  const value = parsed(applicationReviewSchema, input);
  await requireAdmin(env, reviewerId);
  const now = Date.now();
  const row = await env.DB.prepare(`
    UPDATE streamer_applications SET status=?, reviewed_at=?, reviewed_by=?, updated_at=? WHERE id=? RETURNING *
  `)
    .bind(value.decision, now, reviewerId, now, value.id)
    .first<ApplicationRow>();
  if (!row) throw new HttpError(404, "Application not found.");
  return applicationValue(row);
}
