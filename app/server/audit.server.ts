import type { AppEnv } from "../env";
import type { ModerationTarget } from "../types";

// Moderation and admin-security audit row.
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

// Batch audit inserts with their changes. `afterChange` inserts only if the preceding statement changed a row.
export function auditStatement(
  env: AppEnv,
  entry: AuditEntry,
  options: { afterChange?: boolean } = {},
): D1PreparedStatement {
  return env.DB.prepare(`
    INSERT INTO moderation_actions
      (id, target_kind, target_id, streamer_id, action, reason, note, notify_owner, actor_id, metadata, created_at)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${options.afterChange ? "changes() > 0" : "1"}
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

// Hash session IDs for audit labels; raw IDs stay in the session table and cannot be matched from audit rows
// to cookies.
export async function sessionLabel(sessionId: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`admin-session:${sessionId}`));
  return Array.from(new Uint8Array(digest), (byte: number): string => byte.toString(16).padStart(2, "0")).join("");
}
