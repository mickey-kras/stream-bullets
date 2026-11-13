import { z } from "zod";
import { OFFICIAL_BOARD_ID } from "../lib/system";
import {
  type AdminPage,
  type AdminPageList,
  type AdminPerson,
  type EntryStatus,
  MODERATION_REASONS,
  type ModerationEvent,
  PAGE_ACTIONS,
  type PageAction,
  type StreamerStatus,
} from "../types";
import { ENTRY_STATUSES } from "../../db/enums";
import type { AppEnv } from "../env";
import { requireAdmin } from "./access.server";
import { auditStatement } from "./audit.server";
import { deleteEntry } from "./data.server";
import { HttpError } from "./http.server";
import type { AdminSession } from "./stepup.server";
import { isPlaceholderEmail } from "./validation";

// Batch moderation/Ideas changes atomically with `moderation_actions`; access.server.ts owns status rules.

const PAGE_SIZE = 30;
const HISTORY_SIZE = 10;
const id = z.uuid();

export const pageActionSchema = z
  .object({
    action: z.enum(PAGE_ACTIONS),
    reason: z.enum(MODERATION_REASONS),
    note: z.string().trim().max(1000, "Keep the note to 1000 characters or fewer.").default(""),
    notify: z.boolean().default(false),
  })
  .strict();
export type PageActionInput = z.input<typeof pageActionSchema>;

export const pageQuerySchema = z
  .object({
    status: z.enum(["all", "active", "frozen", "suspended"]).default("all"),
    query: z.string().trim().max(60).default(""),
    cursor: z
      .string()
      .regex(/^[a-z0-9_]{3,30}$/u)
      .nullish()
      .transform((value) => value ?? null),
  })
  .strict();
export type PageQuery = z.input<typeof pageQuerySchema>;

export const entryRemovalSchema = z
  .object({
    reason: z.enum(MODERATION_REASONS),
    note: z.string().trim().max(1000).default(""),
  })
  .strict();

export const entryStatusSchema = z
  .object({
    status: z.enum(ENTRY_STATUSES).nullable(),
    reason: z.string().trim().max(500, "Keep the reason to 500 characters or fewer.").default(""),
  })
  .strict();
export type EntryStatusInput = z.input<typeof entryStatusSchema>;

function parsed<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new HttpError(400, result.error.issues[0]?.message ?? "Invalid input.");
  return result.data;
}

// Which statuses each action leaves from, and where it goes.
const transitions: Record<PageAction, { from: readonly StreamerStatus[]; to: StreamerStatus; verb: string }> = {
  freeze: { from: ["active"], to: "frozen", verb: "frozen" },
  unfreeze: { from: ["frozen"], to: "active", verb: "active" },
  suspend: { from: ["active", "frozen"], to: "suspended", verb: "suspended" },
  unsuspend: { from: ["suspended"], to: "active", verb: "active" },
};

// Freezing and suspending need a step-up from the last 2 minutes; lifting them needs the normal 15.
export function isSensitivePageAction(action: unknown): boolean {
  return action === "freeze" || action === "suspend";
}

// Store the owner-visible reason on the page and admin-only note in the audit log. Record notification intent;
// always show the banner and send email only when configured.
export async function moderatePage(
  env: AppEnv,
  admin: AdminSession,
  streamerId: string,
  input: PageActionInput,
  now = Date.now(),
): Promise<{ id: string; handle: string; status: StreamerStatus }> {
  const value = parsed(pageActionSchema, input);
  parsed(id, streamerId);
  await requireAdmin(env, admin.viewer.id);
  const rule = transitions[value.action];
  const lifted = rule.to === "active";
  const [updated] = await env.DB.batch([
    env.DB.prepare(`
      UPDATE streamers SET status=?, status_reason=?, status_changed_at=?, status_changed_by=?, revision=revision+1
      WHERE id=? AND status IN (SELECT value FROM json_each(?))
    `).bind(rule.to, lifted ? null : value.reason, now, admin.viewer.id, streamerId, JSON.stringify(rule.from)),
    env.DB.prepare(`
      INSERT INTO moderation_actions
        (id, target_kind, target_id, streamer_id, action, reason, note, notify_owner, actor_id, metadata, created_at)
      SELECT ?, 'streamer', ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE changes() = 1
    `).bind(
      crypto.randomUUID(),
      streamerId,
      streamerId,
      value.action,
      value.reason,
      value.note,
      value.notify ? 1 : 0,
      admin.viewer.id,
      JSON.stringify({ stepUp: admin.stepUp }),
      now,
    ),
  ]);
  const row = await env.DB.prepare("SELECT id, handle, status FROM streamers WHERE id=?")
    .bind(streamerId)
    .first<{ id: string; handle: string; status: StreamerStatus }>();
  if (!row) throw new HttpError(404, "Streamer not found.");
  if (updated.meta.changes !== 1)
    throw new HttpError(409, `This page is ${row.status}, so you can't ${value.action} it.`, "status_changed");
  return row;
}

export const officialSchema = z.object({ official: z.boolean() }).strict();
export type OfficialInput = z.input<typeof officialSchema>;

// Set/clear official status atomically with an audit row. Unchanged status returns 409. Require fresh step-up,
// as for Freeze/Suspend.
export async function setOfficial(
  env: AppEnv,
  admin: AdminSession,
  streamerId: string,
  input: OfficialInput,
  now = Date.now(),
): Promise<{ id: string; handle: string; isOfficial: boolean }> {
  const value = parsed(officialSchema, input);
  parsed(id, streamerId);
  await requireAdmin(env, admin.viewer.id);
  if (streamerId === OFFICIAL_BOARD_ID && !value.official)
    throw new HttpError(409, "The system Ideas board must remain official.");
  const flag: number = value.official ? 1 : 0;
  const [updated] = await env.DB.batch([
    env.DB.prepare("UPDATE streamers SET is_official=?, revision=revision+1 WHERE id=? AND is_official<>?").bind(
      flag,
      streamerId,
      flag,
    ),
    env.DB.prepare(`
      INSERT INTO moderation_actions
        (id, target_kind, target_id, streamer_id, action, reason, note, notify_owner, actor_id, metadata, created_at)
      SELECT ?, 'streamer', ?, ?, ?, '', '', 0, ?, ?, ? WHERE changes() = 1
    `).bind(
      crypto.randomUUID(),
      streamerId,
      streamerId,
      value.official ? "official" : "unofficial",
      admin.viewer.id,
      JSON.stringify({ stepUp: admin.stepUp }),
      now,
    ),
  ]);
  const row = await env.DB.prepare("SELECT id, handle, is_official FROM streamers WHERE id=?")
    .bind(streamerId)
    .first<{ id: string; handle: string; is_official: number }>();
  if (!row) throw new HttpError(404, "Streamer not found.");
  if (updated.meta.changes !== 1)
    throw new HttpError(
      409,
      row.is_official === 1 ? "This page is already official." : "This page is not official.",
      "status_changed",
    );
  return { id: row.id, handle: row.handle, isOfficial: row.is_official === 1 };
}

interface PageRow {
  id: string;
  handle: string;
  name: string;
  logo: string | null;
  avatar: string | null;
  is_official: number;
  status: StreamerStatus;
  status_reason: string | null;
  status_changed_at: number | null;
  owner_id: string;
  owner_name: string | null;
  owner_email: string | null;
  owner_image: string | null;
  owner_preset: number | null;
  topics: number;
  polls: number;
}

interface HistoryRow {
  id: string;
  streamer_id: string;
  action: string;
  reason: string;
  note: string;
  notify_owner: number;
  actor: string | null;
  created_at: number;
}

// Show only local uploaded images; never echo provider URLs.
export function adminPicture(userId: string | null, image: string | null): string | null {
  return userId && image === `/images/avatar/${encodeURIComponent(userId)}` ? image : null;
}

function ownedImage(kind: "logo", ownerId: string, value: string | null): string | null {
  return value === `/images/${kind}/${encodeURIComponent(ownerId)}` ? value : null;
}

export function validPreset(preset: number | null): number | null {
  return typeof preset === "number" && preset >= 0 && preset <= 17 ? preset : null;
}

export function adminPerson(
  userId: string | null,
  name: string | null,
  image: string | null,
  preset: number | null,
): AdminPerson | null {
  if (!userId || name === null) return null;
  return {
    id: userId,
    name,
    avatar: adminPicture(userId, image),
    avatarPreset: validPreset(preset),
  };
}

function historyValue(row: HistoryRow): ModerationEvent {
  return {
    id: row.id,
    action: row.action,
    reason: row.reason,
    note: row.note,
    notifyOwner: row.notify_owner === 1,
    actor: row.actor,
    createdAt: row.created_at,
  };
}

// Every page for the Streamer pages tab, by handle, with owner, counts and recent moderation history.
export async function listModerationPages(env: AppEnv, adminId: string, query: PageQuery): Promise<AdminPageList> {
  const value = parsed(pageQuerySchema, query);
  await requireAdmin(env, adminId);
  const escapedQuery: string = value.query.toLowerCase().replaceAll(/[\\%_]/gu, String.raw`\$&`);
  const pattern: string = `%${escapedQuery}%`;
  const { results } = await env.DB.prepare(String.raw`
    SELECT s.id, s.handle, s.name, s.logo, s.avatar, s.is_official, s.status, s.status_reason, s.status_changed_at,
      s.owner_id, u.name AS owner_name, u.email AS owner_email, u.image AS owner_image, u.avatar_preset AS owner_preset,
      (SELECT count(*) FROM entries e WHERE e.streamer_id=s.id AND e.kind='topic') AS topics,
      (SELECT count(*) FROM entries e WHERE e.streamer_id=s.id AND e.kind<>'topic') AS polls
    FROM streamers s LEFT JOIN user u ON u.id=s.owner_id
    WHERE (?1='all' OR s.status=?1)
      AND (?2='' OR lower(s.name) LIKE ?3 ESCAPE '\' OR s.handle LIKE ?3 ESCAPE '\')
      AND (?4 IS NULL OR s.handle > ?4)
    ORDER BY s.handle LIMIT ?5
  `)
    .bind(value.status, value.query, pattern, value.cursor, PAGE_SIZE + 1)
    .all<PageRow>();
  const page = results.slice(0, PAGE_SIZE);
  const history = new Map<string, ModerationEvent[]>();
  if (page.length > 0) {
    const { results: events } = await env.DB.prepare(`
      SELECT * FROM (
        SELECT m.id, m.streamer_id, m.action, m.reason, m.note, m.notify_owner, u.name AS actor, m.created_at,
          row_number() OVER (PARTITION BY m.streamer_id ORDER BY m.created_at DESC, m.id DESC) AS position
        FROM moderation_actions m LEFT JOIN user u ON u.id=m.actor_id
        WHERE m.target_kind='streamer' AND m.streamer_id IN (SELECT value FROM json_each(?))
      ) WHERE position <= ? ORDER BY created_at DESC, id DESC
    `)
      .bind(JSON.stringify(page.map((row) => row.id)), HISTORY_SIZE)
      .all<HistoryRow>();
    for (const event of events) {
      const list = history.get(event.streamer_id) ?? [];
      list.push(historyValue(event));
      history.set(event.streamer_id, list);
    }
  }
  const last = page.at(-1);
  return {
    pages: page.map(
      (row): AdminPage => ({
        id: row.id,
        handle: row.handle,
        name: row.name,
        logo: ownedImage("logo", row.owner_id, row.logo),
        avatar: adminPicture(row.owner_id, row.avatar),
        ownerAvatarPreset: validPreset(row.owner_preset),
        isOfficial: row.is_official === 1,
        status: row.status,
        statusReason: row.status_reason,
        statusChangedAt: row.status_changed_at,
        owner: {
          id: row.owner_id,
          name: row.owner_name ?? "",
          avatar: adminPicture(row.owner_id, row.owner_image),
          avatarPreset: validPreset(row.owner_preset),
          email: row.owner_email && !isPlaceholderEmail(row.owner_email) ? row.owner_email : "",
        },
        topics: row.topics,
        polls: row.polls,
        history: history.get(row.id) ?? [],
      }),
    ),
    nextCursor: results.length > PAGE_SIZE && last ? last.handle : null,
  };
}

// Moderation removal ignores page status and closes open reports. Audit only the item ID, never content.
export async function removeEntryAsAdmin(
  env: AppEnv,
  admin: AdminSession,
  entryId: string,
  input: unknown,
  now = Date.now(),
): Promise<{ streamerId: string; resolved: number }> {
  const value = parsed(entryRemovalSchema, input);
  parsed(id, entryId);
  await requireAdmin(env, admin.viewer.id);
  const entry = await env.DB.prepare("SELECT streamer_id FROM entries WHERE id=?")
    .bind(entryId)
    .first<{ streamer_id: string }>();
  if (!entry) throw new HttpError(404, "Topic or poll not found.");
  await deleteEntry(env, admin.viewer.id, entry.streamer_id, entryId, "checked");
  const [closed] = await env.DB.batch([
    env.DB.prepare(`
      UPDATE content_reports SET status='actioned', resolved_at=?, resolved_by=?
      WHERE target_kind='entry' AND target_id=? AND status='open'
    `).bind(now, admin.viewer.id, entryId),
    auditStatement(env, {
      targetKind: "entry",
      targetId: entryId,
      streamerId: entry.streamer_id,
      action: "entry_removed",
      reason: value.reason,
      note: value.note,
      actorId: admin.viewer.id,
      metadata: { stepUp: admin.stepUp },
      createdAt: now,
    }),
  ]);
  return { streamerId: entry.streamer_id, resolved: closed.meta.changes };
}

// Set/clear official-page Ideas status; Not planned needs a reason. Other pages have no Ideas status.
export async function setEntryStatus(
  env: AppEnv,
  admin: AdminSession,
  entryId: string,
  input: EntryStatusInput,
  now = Date.now(),
): Promise<{ streamerId: string; status: EntryStatus | null; statusReason: string | null }> {
  const value = parsed(entryStatusSchema, input);
  parsed(id, entryId);
  await requireAdmin(env, admin.viewer.id);
  const entry = await env.DB.prepare(
    "SELECT e.streamer_id, s.is_official FROM entries e JOIN streamers s ON s.id=e.streamer_id WHERE e.id=?",
  )
    .bind(entryId)
    .first<{ streamer_id: string; is_official: number }>();
  if (!entry) throw new HttpError(404, "Topic or poll not found.");
  if (entry.is_official !== 1) throw new HttpError(409, "Only items on the official page have a status.");
  const reason = value.status === "declined" && value.reason ? value.reason : null;
  await env.DB.batch([
    env.DB.prepare("UPDATE entries SET status=?, status_reason=?, status_changed_at=? WHERE id=?").bind(
      value.status,
      reason,
      now,
      entryId,
    ),
    env.DB.prepare("UPDATE streamers SET revision=revision+1 WHERE id=?").bind(entry.streamer_id),
    auditStatement(env, {
      targetKind: "entry",
      targetId: entryId,
      streamerId: entry.streamer_id,
      action: "entry_status",
      reason: reason ?? "",
      actorId: admin.viewer.id,
      metadata: { status: value.status, stepUp: admin.stepUp },
      createdAt: now,
    }),
  ]);
  return { streamerId: entry.streamer_id, status: value.status, statusReason: reason };
}
