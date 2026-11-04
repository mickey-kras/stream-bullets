import type { z } from "zod";
import type { AppEnv } from "../env";
import type {
  ApplicationQueue,
  ApplicationReviewItem,
  ApplicationStatus,
  StreamerAccess,
  StreamerApplication,
} from "../types";
import { HttpError } from "./http.server";
import {
  applicationQuerySchema,
  applicationReviewSchema,
  applicationSchema,
  type ApplicationInput,
  type ApplicationQuery,
  type ApplicationReview,
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

/** Parses the operator-managed admin list. Entries are separated by commas or whitespace. */
export function adminEmails(env: AppEnv): Set<string> {
  return new Set(
    (env.ADMIN_EMAILS ?? "")
      .split(/[\s,]+/u)
      .map((email: string): string => email.trim().toLowerCase())
      .filter((email: string): boolean => email.includes("@")),
  );
}

/** An admin has a verified email address that the operator lists in ADMIN_EMAILS. */
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

/** Describes what the account may do with streamer profiles. */
export async function getStreamerAccess(env: AppEnv, userId: string): Promise<StreamerAccess> {
  const [admin, application] = await Promise.all([isAdmin(env, userId), getApplication(env, userId)]);
  return { admin, application, canCreateStreamer: admin || application?.status === "approved" };
}

export async function canCreateStreamer(env: AppEnv, userId: string): Promise<boolean> {
  return (await getStreamerAccess(env, userId)).canCreateStreamer;
}

/**
 * Adds the account to the streamer waitlist, or updates a pending or rejected request.
 * A rejected request returns to the queue as pending. Approved requests cannot change.
 */
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

/** Lists applications for review. Pending requests come oldest first; reviewed ones newest first. */
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
        email: row.email,
      }),
    ),
    nextCursor: results.length > QUEUE_PAGE_SIZE && last ? `${last.updated_at}.${last.id}` : null,
  };
}

/** Records an admin decision. Approval lets the applicant create one streamer profile. */
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
