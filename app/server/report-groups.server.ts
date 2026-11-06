import { z } from "zod";
import type { ReportGroup, ReportGroupFilter, ReportItem, ReportItemList } from "../admin-types";
import type { AppEnv } from "../env";
import type { ReportReason, ReportStatus, ReportTargetKind, StreamerStatus } from "../types";
import { requireAdmin } from "./access.server";
import { auditStatement } from "./audit.server";
import { HttpError } from "./http.server";
import { adminPerson, adminPicture, validPreset } from "./moderation.server";
import { resolveOpenReports, type ReportResult } from "./reports.server";
import type { AdminSession } from "./stepup.server";

/* Content reports grouped by streamer page, then de-duplicated by reported item (item 27). */

export const reportGroupQuerySchema = z
  .object({
    group: z.literal("streamer"),
    status: z.enum(["open", "resolved", "all"]).default("open"),
  })
  .strict();

export const reportItemQuerySchema = z
  .object({
    streamer: z.uuid(),
    status: z.enum(["open", "resolved", "all"]).default("open"),
  })
  .strict();

export const reportBulkSchema = z.union([
  z.object({ streamerId: z.uuid(), action: z.literal("dismiss") }).strict(),
  z
    .object({ targetKind: z.enum(["entry", "comment"]), targetId: z.uuid(), action: z.enum(["remove", "dismiss"]) })
    .strict(),
]);
export type ReportBulkInput = z.infer<typeof reportBulkSchema>;

const GROUP_LIMIT = 100;
const ITEM_REPORT_LIMIT = 500;
const THIRTY_DAYS = 30 * 86_400_000;

function parsed<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new HttpError(400, result.error.issues[0]?.message ?? "Invalid input.");
  return result.data;
}

/** SQL for the status filter. Only these three constant strings reach the query. */
function statusFilter(filter: ReportGroupFilter): string {
  if (filter === "open") return "r.status = 'open'";
  if (filter === "resolved") return "r.status <> 'open'";
  return "1 = 1";
}

interface StreamerColumns {
  streamer_id: string;
  handle: string | null;
  name: string | null;
  logo: string | null;
  avatar: string | null;
  owner_id: string | null;
  owner_preset: number | null;
  page_status: StreamerStatus | null;
}

interface GroupRow extends StreamerColumns {
  reports: number;
  items: number;
  open: number;
  last_30_days: number;
  newest: number;
}

const streamerColumns = `
  s.handle, s.name, s.logo, s.avatar, s.owner_id, s.status AS page_status,
  (SELECT avatar_preset FROM user WHERE user.id = s.owner_id) AS owner_preset`;

function groupStreamer(row: StreamerColumns): ReportGroup["streamer"] {
  if (row.handle === null || row.owner_id === null) return null;
  return {
    id: row.streamer_id,
    handle: row.handle,
    name: row.name ?? row.handle,
    logo: row.logo === `/images/logo/${encodeURIComponent(row.owner_id)}` ? row.logo : null,
    avatar: adminPicture(row.owner_id, row.avatar),
    ownerAvatarPreset: validPreset(row.owner_preset),
    status: row.page_status ?? "active",
  };
}

/** One card per streamer page: counts, newest report and top reasons. Pages with most open reports come first. */
export async function listReportGroups(
  env: AppEnv,
  adminId: string,
  query: z.input<typeof reportGroupQuerySchema>,
  now = Date.now(),
): Promise<ReportGroup[]> {
  const value = parsed(reportGroupQuerySchema, query);
  await requireAdmin(env, adminId);
  const filter = statusFilter(value.status);
  const { results } = await env.DB.prepare(`
    SELECT g.*, ${streamerColumns} FROM (
      SELECT r.streamer_id,
        sum(CASE WHEN ${filter} THEN 1 ELSE 0 END) AS reports,
        count(DISTINCT CASE WHEN ${filter} THEN r.target_kind || ':' || r.target_id END) AS items,
        sum(CASE WHEN r.status = 'open' THEN 1 ELSE 0 END) AS open,
        sum(CASE WHEN r.created_at > ? THEN 1 ELSE 0 END) AS last_30_days,
        max(CASE WHEN ${filter} THEN r.created_at END) AS newest
      FROM content_reports r GROUP BY r.streamer_id
    ) g LEFT JOIN streamers s ON s.id = g.streamer_id
    WHERE g.reports > 0
    ORDER BY g.open DESC, g.newest DESC LIMIT ?
  `)
    .bind(now - THIRTY_DAYS, GROUP_LIMIT)
    .all<GroupRow>();
  if (results.length === 0) return [];
  const { results: reasons } = await env.DB.prepare(`
    SELECT r.streamer_id, r.reason, count(*) AS total FROM content_reports r
    WHERE ${filter} AND r.streamer_id IN (SELECT value FROM json_each(?))
    GROUP BY r.streamer_id, r.reason ORDER BY total DESC, r.reason
  `)
    .bind(JSON.stringify(results.map((row) => row.streamer_id)))
    .all<{ streamer_id: string; reason: ReportReason; total: number }>();
  return results.map((row) => ({
    streamerId: row.streamer_id,
    streamer: groupStreamer(row),
    reports: row.reports,
    items: row.items,
    open: row.open,
    last30Days: row.last_30_days,
    newest: row.newest,
    reasons: reasons
      .filter((reason) => reason.streamer_id === row.streamer_id)
      .map((reason) => ({ reason: reason.reason, count: reason.total })),
  }));
}

interface ItemReportRow {
  id: string;
  target_kind: ReportTargetKind;
  target_id: string;
  reason: ReportReason;
  details: string;
  snapshot: string;
  status: ReportStatus;
  created_at: number;
  resolved_at: number | null;
  reporter_id: string | null;
  reporter_name: string | null;
  reporter_image: string | null;
  reporter_preset: number | null;
  author_id: string | null;
  author_name: string | null;
  author_image: string | null;
  author_preset: number | null;
  entry_id: string | null;
}

function itemStatus(reports: ItemReportRow[]): { status: ReportStatus; resolvedAt: number | null } {
  if (reports.some((report) => report.status === "open")) return { status: "open", resolvedAt: null };
  const latest = reports.reduce((best, report) => ((report.resolved_at ?? 0) > (best.resolved_at ?? 0) ? report : best));
  return { status: latest.status, resolvedAt: latest.resolved_at };
}

function itemValue(reports: ItemReportRow[]): ReportItem {
  const [first] = reports;
  return {
    targetKind: first.target_kind,
    targetId: first.target_id,
    entryId: first.entry_id,
    snapshot: first.snapshot,
    author: adminPerson(first.author_id, first.author_name, first.author_image, first.author_preset),
    ...itemStatus(reports),
    reports: reports.map((report) => ({
      id: report.id,
      reason: report.reason,
      details: report.details,
      status: report.status,
      createdAt: report.created_at,
      reporter: adminPerson(report.reporter_id, report.reporter_name, report.reporter_image, report.reporter_preset),
    })),
  };
}

/**
 * The reports on one page, de-duplicated by item: one row per topic, poll or comment with every report about
 * it ("Reported by N people"), newest report first. Items with an open report come first.
 */
export async function listReportItems(
  env: AppEnv,
  adminId: string,
  query: z.input<typeof reportItemQuerySchema>,
): Promise<ReportItemList> {
  const value = parsed(reportItemQuerySchema, query);
  await requireAdmin(env, adminId);
  const { results } = await env.DB.prepare(`
    SELECT r.id, r.target_kind, r.target_id, r.reason, r.details, r.snapshot, r.status, r.created_at, r.resolved_at,
      r.reporter_id, ru.name AS reporter_name, ru.image AS reporter_image, ru.avatar_preset AS reporter_preset,
      r.target_author_id AS author_id, au.name AS author_name, au.image AS author_image,
      au.avatar_preset AS author_preset,
      CASE r.target_kind
        WHEN 'entry' THEN (SELECT e.id FROM entries e WHERE e.id=r.target_id AND e.streamer_id=r.streamer_id)
        ELSE (SELECT c.entry_id FROM entry_comments c WHERE c.id=r.target_id AND c.removed_at IS NULL)
      END AS entry_id
    FROM content_reports r
    LEFT JOIN user ru ON ru.id = r.reporter_id
    LEFT JOIN user au ON au.id = r.target_author_id
    WHERE r.streamer_id = ? AND ${statusFilter(value.status)}
    ORDER BY r.created_at DESC, r.id DESC LIMIT ?
  `)
    .bind(value.streamer, ITEM_REPORT_LIMIT)
    .all<ItemReportRow>();
  const items = new Map<string, ItemReportRow[]>();
  for (const row of results) {
    const key = `${row.target_kind}:${row.target_id}`;
    items.set(key, [...(items.get(key) ?? []), row]);
  }
  const page = await env.DB.prepare(`SELECT s.id AS streamer_id, ${streamerColumns} FROM streamers s WHERE s.id = ?`)
    .bind(value.streamer)
    .first<StreamerColumns>();
  const list = [...items.values()].map(itemValue);
  list.sort((a, b) => Number(b.status === "open") - Number(a.status === "open"));
  return { streamer: page ? groupStreamer(page) : null, items: list };
}

/**
 * Resolves in bulk: every open report about one item (remove or dismiss), or every open report on one page
 * (dismiss only: content is never removed in bulk). Each decision writes one audit row.
 */
export async function resolveReports(
  env: AppEnv,
  admin: AdminSession,
  input: ReportBulkInput,
  now = Date.now(),
): Promise<ReportResult> {
  const value = parsed(reportBulkSchema, input);
  await requireAdmin(env, admin.viewer.id);
  if ("streamerId" in value) {
    const [result] = await env.DB.batch([
      env.DB.prepare(`
        UPDATE content_reports SET status='dismissed', resolved_at=?, resolved_by=? WHERE streamer_id=? AND status='open'
      `).bind(now, admin.viewer.id, value.streamerId),
      auditStatement(env, {
        targetKind: "report",
        targetId: `streamer:${value.streamerId}`,
        streamerId: value.streamerId,
        action: "reports_dismissed",
        actorId: admin.viewer.id,
        metadata: { stepUp: admin.stepUp },
        createdAt: now,
      }),
    ]);
    return { status: "dismissed", resolved: result.meta.changes, streamerId: null };
  }
  return resolveOpenReports(
    env,
    { actorId: admin.viewer.id, stepUp: admin.stepUp },
    value.targetKind,
    value.targetId,
    value.action,
    now,
  );
}
