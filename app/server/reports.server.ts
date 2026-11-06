import type { z } from "zod";
import type { AppEnv } from "../env";
import type { ContentReport, ReportQueue, ReportReason, ReportStatus, ReportTargetKind } from "../types";
import { requireAdmin } from "./access.server";
import { consumeMutationQuota, deleteComment, deleteEntry } from "./data.server";
import { HttpError } from "./http.server";
import {
  reportQuerySchema,
  reportResolutionSchema,
  reportSchema,
  type ReportInput,
  type ReportQuery,
  type ReportResolution,
} from "./validation";

const QUEUE_PAGE_SIZE = 50;
const SNAPSHOT_LENGTH = 2000;

interface ReportRow {
  id: string;
  target_kind: ReportTargetKind;
  target_id: string;
  streamer_id: string;
  reason: ReportReason;
  details: string;
  snapshot: string;
  status: ReportStatus;
  created_at: number;
  resolved_at: number | null;
  reporter_name: string | null;
  handle: string | null;
  entry_id: string | null;
}

interface TargetRow {
  streamer_id: string;
  author_id: string;
  snapshot: string;
}

export interface ReportResult {
  status: ReportStatus;
  /** Open reports about the same content that this decision closed. */
  resolved: number;
  /** The streamer page that changed, so live viewers can refresh. Null when nothing was removed. */
  streamerId: string | null;
}

function parsed<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new HttpError(400, result.error.issues[0]?.message ?? "Invalid input.");
  return result.data;
}

function clip(value: string): string {
  const characters = Array.from(value.trim());
  return characters.length > SNAPSHOT_LENGTH
    ? `${characters.slice(0, SNAPSHOT_LENGTH - 1).join("")}…`
    : characters.join("");
}

/** Reads the reported content and copies its text, so admins can review it after edits or deletion. */
async function reportTarget(env: AppEnv, kind: ReportTargetKind, id: string): Promise<TargetRow> {
  const statement =
    kind === "entry"
      ? env.DB.prepare(`SELECT streamer_id, author_id,
          title || CASE WHEN body <> '' THEN char(10) || char(10) || body ELSE '' END ||
          CASE WHEN kind <> 'topic' THEN char(10) || char(10) || 'Options: ' ||
            (SELECT group_concat(value, ' · ') FROM json_each(options)) ELSE '' END AS snapshot
        FROM entries WHERE id=?`)
      : env.DB.prepare(`SELECT e.streamer_id, c.author_id, c.text AS snapshot
        FROM entry_comments c JOIN entries e ON e.id=c.entry_id WHERE c.id=? AND c.removed_at IS NULL`);
  const row = await statement.bind(id).first<TargetRow>();
  if (!row) throw new HttpError(404, kind === "entry" ? "Topic or poll not found." : "Comment not found.");
  return row;
}

/**
 * Records a notice about content that may be illegal or break the community rules.
 * Only signed-in accounts can report, which keeps notices accountable and limits abuse.
 * A repeated report about the same content updates the reporter's open notice.
 */
export async function submitReport(
  env: AppEnv,
  reporterId: string,
  input: ReportInput,
): Promise<{ id: string; createdAt: number }> {
  const value = parsed(reportSchema, input);
  await consumeMutationQuota(env, reporterId);
  await consumeMutationQuota(env, reporterId, true);
  const target = await reportTarget(env, value.targetKind, value.targetId);
  if (target.author_id === reporterId) throw new HttpError(400, "You can't report your own content.");
  const row = await env.DB.prepare(`
    INSERT INTO content_reports (id, target_kind, target_id, streamer_id, reporter_id, target_author_id, reason, details, snapshot, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)
    ON CONFLICT(reporter_id, target_kind, target_id) WHERE status = 'open' DO UPDATE SET
      reason=excluded.reason, details=excluded.details
    RETURNING id, created_at
  `)
    .bind(
      crypto.randomUUID(),
      value.targetKind,
      value.targetId,
      target.streamer_id,
      reporterId,
      target.author_id,
      value.reason,
      value.details,
      clip(target.snapshot),
      Date.now(),
    )
    .first<{ id: string; created_at: number }>();
  if (!row) throw new Error("The report was not saved.");
  return { id: row.id, createdAt: row.created_at };
}

function decodeQueueCursor(value: string | null): { time: number; id: string } | null {
  if (value === null) return null;
  const match = /^(\d{1,15})\.([a-f0-9-]{36})$/u.exec(value);
  if (!match) throw new HttpError(400, "Invalid page cursor.");
  return { time: Number(match[1]), id: match[2] };
}

function reportValue(row: ReportRow): ContentReport {
  return {
    id: row.id,
    targetKind: row.target_kind,
    targetId: row.target_id,
    reason: row.reason,
    details: row.details,
    snapshot: row.snapshot,
    status: row.status,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
    reporterName: row.reporter_name,
    streamerHandle: row.handle,
    entryId: row.entry_id,
  };
}

/** Lists reports for administrators. Open reports come oldest first; resolved ones newest first. */
export async function listReports(env: AppEnv, adminId: string, query: ReportQuery): Promise<ReportQueue> {
  await requireAdmin(env, adminId);
  const value = parsed(reportQuerySchema, query);
  const cursor = decodeQueueCursor(value.cursor);
  const ascending = value.status === "open";
  const comparison = ascending ? ">" : "<";
  const direction = ascending ? "ASC" : "DESC";
  const bindings: (string | number)[] = [value.status];
  let where = "r.status=?";
  if (cursor) {
    where += ` AND (r.created_at ${comparison} ? OR (r.created_at = ? AND r.id ${comparison} ?))`;
    bindings.push(cursor.time, cursor.time, cursor.id);
  }
  const { results } = await env.DB.prepare(`
    SELECT r.*, u.name AS reporter_name, s.handle AS handle,
      CASE r.target_kind
        WHEN 'entry' THEN (SELECT e.id FROM entries e WHERE e.id=r.target_id AND e.streamer_id=r.streamer_id)
        ELSE (SELECT c.entry_id FROM entry_comments c WHERE c.id=r.target_id)
      END AS entry_id
    FROM content_reports r
    LEFT JOIN user u ON u.id=r.reporter_id
    LEFT JOIN streamers s ON s.id=r.streamer_id
    WHERE ${where} ORDER BY r.created_at ${direction}, r.id ${direction} LIMIT ?
  `)
    .bind(...bindings, QUEUE_PAGE_SIZE + 1)
    .all<ReportRow>();
  const page = results.slice(0, QUEUE_PAGE_SIZE);
  const last = page.at(-1);
  return {
    reports: page.map(reportValue),
    nextCursor: results.length > QUEUE_PAGE_SIZE && last ? `${last.created_at}.${last.id}` : null,
  };
}

async function removeTarget(env: AppEnv, adminId: string, report: ReportRow): Promise<string | null> {
  try {
    if (report.target_kind === "entry") {
      await deleteEntry(env, adminId, report.streamer_id, report.target_id);
      return report.streamer_id;
    }
    return (await deleteComment(env, adminId, report.target_id)).streamerId;
  } catch (error: unknown) {
    // The author or streamer may have removed the content already; the report can still be closed.
    if (error instanceof HttpError && error.status === 404) return null;
    throw error;
  }
}

/**
 * Records an administrator decision. Removal deletes the content with the usual deletion rules
 * (a removed comment with replies stays as a "Comment removed" placeholder). Either decision closes every open
 * report about the same content.
 */
export async function resolveReport(env: AppEnv, adminId: string, input: ReportResolution): Promise<ReportResult> {
  const value = parsed(reportResolutionSchema, input);
  await requireAdmin(env, adminId);
  const report = await env.DB.prepare("SELECT * FROM content_reports WHERE id=?").bind(value.id).first<ReportRow>();
  if (!report) throw new HttpError(404, "Report not found.");
  if (report.status !== "open") throw new HttpError(409, "This report is already resolved.");
  const streamerId = value.action === "remove" ? await removeTarget(env, adminId, report) : null;
  const status: ReportStatus = value.action === "remove" ? "actioned" : "dismissed";
  const result = await env.DB.prepare(`
    UPDATE content_reports SET status=?, resolved_at=?, resolved_by=?
    WHERE target_kind=? AND target_id=? AND status='open'
  `)
    .bind(status, Date.now(), adminId, report.target_kind, report.target_id)
    .run();
  return { status, resolved: result.meta.changes, streamerId };
}
