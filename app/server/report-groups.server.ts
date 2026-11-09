import { z } from "zod";
import type {
  ReportGroup,
  ReportGroupFilter,
  ReportGroupList,
  ReportItem,
  ReportItemList,
  ReportReason,
  ReportStatus,
  ReportTargetKind,
  StreamerStatus,
} from "../types";
import type { AppEnv } from "../env";
import { requireAdmin } from "./access.server";
import { auditStatement } from "./audit.server";
import { HttpError } from "./http.server";
import { adminPerson, adminPicture, validPreset } from "./moderation.server";
import { resolveOpenReports, type ReportResult } from "./reports.server";
import type { AdminSession } from "./stepup.server";

/* Content reports grouped by streamer page, then de-duplicated by reported item (item 27). */

/** Keyset cursor over the group order: most open reports, then newest report, then page id. */
const GROUP_CURSOR = /^(\d{1,9})\.(\d{1,16})\.([0-9a-f-]{36})$/u;

export const reportGroupQuerySchema = z
  .object({
    group: z.literal("streamer"),
    status: z.enum(["open", "resolved", "all"]).default("open"),
    query: z.string().trim().max(60).default(""),
    cursor: z
      .string()
      .regex(GROUP_CURSOR)
      .nullish()
      .transform((value) => value ?? null),
  })
  .strict();

/** Keyset cursor over the item order: open first, then newest report, then kind and id. */
const CURSOR = /^([01])\.(\d{1,16})\.(entry|comment)\.([0-9a-f-]{36})$/u;

export const reportItemQuerySchema = z
  .object({
    streamer: z.uuid(),
    status: z.enum(["open", "resolved", "all"]).default("open"),
    cursor: z
      .string()
      .regex(CURSOR)
      .nullish()
      .transform((value) => value ?? null),
  })
  .strict();

export const reportBulkSchema = z.union([
  z.object({ streamerId: z.uuid(), action: z.literal("dismiss") }).strict(),
  z
    .object({ targetKind: z.enum(["entry", "comment"]), targetId: z.uuid(), action: z.enum(["remove", "dismiss"]) })
    .strict(),
]);
export type ReportBulkInput = z.infer<typeof reportBulkSchema>;

const GROUP_PAGE_SIZE = 100;
const ITEM_PAGE_SIZE = 50;
const ITEM_REPORT_LIMIT = 50;
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

/**
 * One card per streamer page: counts, newest report and top reasons. Pages with most open reports come first,
 * `GROUP_PAGE_SIZE` at a time; `query` matches the page handle or name. Counts cover every report in the filter.
 */
export async function listReportGroups(
  env: AppEnv,
  adminId: string,
  query: z.input<typeof reportGroupQuerySchema>,
  now = Date.now(),
): Promise<ReportGroupList> {
  const value = parsed(reportGroupQuerySchema, query);
  await requireAdmin(env, adminId);
  const filter = statusFilter(value.status);
  const cursor = value.cursor ? GROUP_CURSOR.exec(value.cursor) : null;
  const escapedQuery: string = value.query.toLowerCase().replaceAll(/[\\%_]/gu, String.raw`\$&`);
  const pattern: string = `%${escapedQuery}%`;
  const { results: rows } = await env.DB.prepare(String.raw`
    SELECT g.*, ${streamerColumns} FROM (
      SELECT r.streamer_id,
        sum(CASE WHEN ${filter} THEN 1 ELSE 0 END) AS reports,
        count(DISTINCT CASE WHEN ${filter} THEN r.target_kind || ':' || r.target_id END) AS items,
        sum(CASE WHEN r.status = 'open' THEN 1 ELSE 0 END) AS open,
        sum(CASE WHEN r.created_at > ?1 THEN 1 ELSE 0 END) AS last_30_days,
        max(CASE WHEN ${filter} THEN r.created_at END) AS newest
      FROM content_reports r GROUP BY r.streamer_id
    ) g LEFT JOIN streamers s ON s.id = g.streamer_id
    WHERE g.reports > 0
      AND (?2 = '' OR lower(s.name) LIKE ?3 ESCAPE '\' OR s.handle LIKE ?3 ESCAPE '\')
      AND (?4 IS NULL OR (g.open, g.newest, g.streamer_id) < (?4, ?5, ?6))
    ORDER BY g.open DESC, g.newest DESC, g.streamer_id DESC LIMIT ?7
  `)
    .bind(
      now - THIRTY_DAYS,
      value.query,
      pattern,
      cursor ? Number(cursor[1]) : null,
      cursor ? Number(cursor[2]) : null,
      cursor?.[3] ?? null,
      GROUP_PAGE_SIZE + 1,
    )
    .all<GroupRow>();
  const results = rows.slice(0, GROUP_PAGE_SIZE);
  const last = rows.length > GROUP_PAGE_SIZE ? results[results.length - 1] : null;
  const next = last ? `${last.open}.${last.newest}.${last.streamer_id}` : null;
  if (results.length === 0) return { groups: [], next };
  const { results: reasons } = await env.DB.prepare(`
    SELECT r.streamer_id, r.reason, count(*) AS total FROM content_reports r
    WHERE ${filter} AND r.streamer_id IN (SELECT value FROM json_each(?))
    GROUP BY r.streamer_id, r.reason ORDER BY total DESC, r.reason
  `)
    .bind(JSON.stringify(results.map((row) => row.streamer_id)))
    .all<{ streamer_id: string; reason: ReportReason; total: number }>();
  const groups = results.map((row) => ({
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
  return { groups, next };
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

interface ItemSummaryRow {
  target_kind: ReportTargetKind;
  target_id: string;
  has_open: number;
  newest: number;
  total: number;
  open_count: number;
  resolved_status: ReportStatus | null;
  resolved_at: number | null;
}

function itemCursor(row: ItemSummaryRow): string {
  return `${row.has_open}.${row.newest}.${row.target_kind}.${row.target_id}`;
}

function itemKey(kind: string, id: string): string {
  return `${kind}:${id}`;
}

function itemValue(
  summary: ItemSummaryRow,
  reports: ItemReportRow[],
  reasons: { reason: ReportReason; count: number }[],
): ReportItem {
  const [first] = reports;
  const open = summary.has_open === 1;
  return {
    targetKind: summary.target_kind,
    targetId: summary.target_id,
    entryId: first.entry_id,
    snapshot: first.snapshot,
    author: adminPerson(first.author_id, first.author_name, first.author_image, first.author_preset),
    status: open ? "open" : (summary.resolved_status ?? "dismissed"),
    resolvedAt: open ? null : summary.resolved_at,
    reportCount: summary.total,
    openCount: summary.open_count,
    reasons,
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
 * The reports on one page, de-duplicated by item: one row per topic, poll or comment ("Reported by N people"),
 * items with an open report first, then by newest report. Pages hold `ITEM_PAGE_SIZE` items; counts, reasons and
 * status cover every report in the filter, while each item lists only its newest `ITEM_REPORT_LIMIT` reports.
 */
export async function listReportItems(
  env: AppEnv,
  adminId: string,
  query: z.input<typeof reportItemQuerySchema>,
): Promise<ReportItemList> {
  const value = parsed(reportItemQuerySchema, query);
  await requireAdmin(env, adminId);
  const filter = statusFilter(value.status);
  const cursor = value.cursor ? CURSOR.exec(value.cursor) : null;
  const { results: summaries } = await env.DB.prepare(`
    SELECT p.*,
      (SELECT x.status FROM content_reports x
        WHERE x.streamer_id = ?1 AND x.target_kind = p.target_kind AND x.target_id = p.target_id AND x.status <> 'open'
        ORDER BY x.resolved_at DESC, x.created_at DESC LIMIT 1) AS resolved_status
    FROM (
      SELECT r.target_kind, r.target_id, max(r.status = 'open') AS has_open, max(r.created_at) AS newest,
        count(*) AS total, sum(r.status = 'open') AS open_count, max(r.resolved_at) AS resolved_at
      FROM content_reports r WHERE r.streamer_id = ?1 AND ${filter}
      GROUP BY r.target_kind, r.target_id
      HAVING ?2 IS NULL OR (has_open, newest, r.target_kind, r.target_id) < (?2, ?3, ?4, ?5)
      ORDER BY has_open DESC, newest DESC, r.target_kind DESC, r.target_id DESC LIMIT ?6
    ) p
    ORDER BY p.has_open DESC, p.newest DESC, p.target_kind DESC, p.target_id DESC
  `)
    .bind(
      value.streamer,
      cursor ? Number(cursor[1]) : null,
      cursor ? Number(cursor[2]) : null,
      cursor?.[3] ?? null,
      cursor?.[4] ?? null,
      ITEM_PAGE_SIZE + 1,
    )
    .all<ItemSummaryRow>();
  const more = summaries.length > ITEM_PAGE_SIZE;
  const pageItems = summaries.slice(0, ITEM_PAGE_SIZE);
  const keys = JSON.stringify(pageItems.map((row) => itemKey(row.target_kind, row.target_id)));
  const targets = JSON.stringify(pageItems.map((row) => row.target_id));
  const [reports, reasons, page] = await Promise.all([
    env.DB.prepare(`
      SELECT * FROM (
        SELECT r.id, r.target_kind, r.target_id, r.reason, r.details, r.snapshot, r.status, r.created_at,
          r.reporter_id, ru.name AS reporter_name, ru.image AS reporter_image, ru.avatar_preset AS reporter_preset,
          r.target_author_id AS author_id, au.name AS author_name, au.image AS author_image,
          au.avatar_preset AS author_preset,
          CASE r.target_kind
            WHEN 'entry' THEN (SELECT e.id FROM entries e WHERE e.id=r.target_id AND e.streamer_id=r.streamer_id)
            ELSE (SELECT c.entry_id FROM entry_comments c WHERE c.id=r.target_id AND c.removed_at IS NULL)
          END AS entry_id,
          row_number() OVER (PARTITION BY r.target_kind, r.target_id ORDER BY r.created_at DESC, r.id DESC) AS position
        FROM content_reports r
        LEFT JOIN user ru ON ru.id = r.reporter_id
        LEFT JOIN user au ON au.id = r.target_author_id
        WHERE r.streamer_id = ? AND ${filter} AND r.target_id IN (SELECT value FROM json_each(?))
          AND r.target_kind || ':' || r.target_id IN (SELECT value FROM json_each(?))
      ) WHERE position <= ? ORDER BY created_at DESC, id DESC
    `)
      .bind(value.streamer, targets, keys, ITEM_REPORT_LIMIT)
      .all<ItemReportRow>(),
    env.DB.prepare(`
      SELECT r.target_kind, r.target_id, r.reason, count(*) AS total FROM content_reports r
      WHERE r.streamer_id = ? AND ${filter} AND r.target_id IN (SELECT value FROM json_each(?))
        AND r.target_kind || ':' || r.target_id IN (SELECT value FROM json_each(?))
      GROUP BY r.target_kind, r.target_id, r.reason ORDER BY total DESC, r.reason
    `)
      .bind(value.streamer, targets, keys)
      .all<{ target_kind: string; target_id: string; reason: ReportReason; total: number }>(),
    env.DB.prepare(`SELECT s.id AS streamer_id, ${streamerColumns} FROM streamers s WHERE s.id = ?`)
      .bind(value.streamer)
      .first<StreamerColumns>(),
  ]);
  const byItem = new Map<string, ItemReportRow[]>();
  for (const row of reports.results) {
    const key = itemKey(row.target_kind, row.target_id);
    byItem.set(key, [...(byItem.get(key) ?? []), row]);
  }
  const items = pageItems.map((summary) => {
    const key = itemKey(summary.target_kind, summary.target_id);
    const counts = reasons.results
      .filter((row) => itemKey(row.target_kind, row.target_id) === key)
      .map((row) => ({ reason: row.reason, count: row.total }));
    return itemValue(summary, byItem.get(key) ?? [], counts);
  });
  return {
    streamer: page ? groupStreamer(page) : null,
    items,
    next: more ? itemCursor(pageItems[pageItems.length - 1]) : null,
  };
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
