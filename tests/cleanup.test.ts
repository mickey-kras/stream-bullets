import { expect, it } from "vitest";
import { cleanExpiredData, REPORT_RETENTION_MS } from "../app/server/cleanup.server";
import { createTestDatabase } from "./helpers/database";
import type { AppEnv } from "../app/env";

it("removes expired session and limiter data without revoking active sessions", async () => {
  const database = await createTestDatabase();
  const now = Date.now();
  try {
    await database.db
      .prepare("INSERT INTO user (id,name,email,created_at,updated_at) VALUES (?,?,?,?,?)")
      .bind("cleanup-user", "User", "cleanup@example.test", now, now)
      .run();
    for (const [id, expiresAt] of [
      ["expired", now - 1],
      ["active", now + 60_000],
    ] as const) {
      await database.db
        .prepare("INSERT INTO session (id,token,user_id,expires_at,created_at,updated_at) VALUES (?,?,?,?,?,?)")
        .bind(id, id, "cleanup-user", expiresAt, now, now)
        .run();
      await database.db
        .prepare("INSERT INTO verification (id,identifier,value,expires_at,created_at,updated_at) VALUES (?,?,?,?,?,?)")
        .bind(id, id, "test", expiresAt, now, now)
        .run();
      const windowStart = id === "expired" ? now - 172_800_000 : now;
      await database.db
        .prepare("INSERT INTO rate_limit (id,key,count,last_request) VALUES (?,?,?,?)")
        .bind(id, id, 1, windowStart)
        .run();
      await database.db
        .prepare("INSERT INTO app_rate_limits (key,count,window_start) VALUES (?,?,?)")
        .bind(id, 1, windowStart)
        .run();
    }
    await cleanExpiredData({ DB: database.db } as AppEnv, now);
    for (const table of ["session", "verification", "rate_limit", "app_rate_limits"]) {
      expect(await database.db.prepare(`SELECT count(*) AS count FROM ${table}`).first("count")).toBe(1);
    }
    expect(await database.db.prepare("SELECT id FROM session").first("id")).toBe("active");
  } finally {
    await database.dispose();
  }
});

it("keeps open and recent reports and removes resolved reports after the retention period", async () => {
  const database = await createTestDatabase();
  const now = Date.now();
  try {
    const report = (id: string, status: string, resolvedAt: number | null): D1PreparedStatement =>
      database.db
        .prepare(
          `INSERT INTO content_reports (id,target_kind,target_id,streamer_id,reason,details,snapshot,status,created_at,resolved_at)
            VALUES (?,'entry',?,'page','spam','','Text',?,1,?)`,
        )
        .bind(id, id, status, resolvedAt);
    await database.db.batch([
      report("open-old", "open", null),
      report("resolved-recent", "dismissed", now - REPORT_RETENTION_MS + 60_000),
      report("resolved-old", "actioned", now - REPORT_RETENTION_MS - 1),
    ]);
    await cleanExpiredData({ DB: database.db } as AppEnv, now);
    const rows = await database.db.prepare("SELECT id FROM content_reports ORDER BY id").all<{ id: string }>();
    expect(rows.results.map((row: { id: string }) => row.id)).toEqual(["open-old", "resolved-recent"]);
  } finally {
    await database.dispose();
  }
});
