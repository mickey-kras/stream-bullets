import type { AppEnv } from "../env";
import type { ModerationTarget } from "../admin-types";

/** One row of the moderation and admin-security audit log (`moderation_actions`, item 29). */
export interface AuditEntry {
  targetKind: ModerationTarget;
  targetId: string;
  streamerId?: string | null;
  action: string;
  reason?: string;
  note?: string;
  notifyOwner?: boolean;
  actorId: string;
  metadata?: Record<string, unknown> | null;
  createdAt?: number;
}

/** The insert statement for one audit row, so callers can batch it with the change it records. */
export function auditStatement(env: AppEnv, entry: AuditEntry): D1PreparedStatement {
  return env.DB.prepare(`
    INSERT INTO moderation_actions
      (id, target_kind, target_id, streamer_id, action, reason, note, notify_owner, actor_id, metadata, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    crypto.randomUUID(),
    entry.targetKind,
    entry.targetId,
    entry.streamerId ?? null,
    entry.action,
    entry.reason ?? "",
    entry.note ?? "",
    entry.notifyOwner ? 1 : 0,
    entry.actorId,
    entry.metadata ? JSON.stringify(entry.metadata) : null,
    entry.createdAt ?? Date.now(),
  );
}

export async function recordAudit(env: AppEnv, entry: AuditEntry): Promise<void> {
  await auditStatement(env, entry).run();
}

/**
 * A stable, non-reversible label for a session in the audit log. The raw session id never leaves the session
 * table, so a leaked audit row cannot be matched to a cookie.
 */
export async function sessionLabel(sessionId: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`admin-session:${sessionId}`));
  return Array.from(new Uint8Array(digest), (byte: number): string => byte.toString(16).padStart(2, "0")).join("");
}
