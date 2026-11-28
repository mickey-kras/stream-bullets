import { expect, it } from "vitest";
import {
  cleanExpiredData,
  FEATURE_RETENTION_MS,
  REPORT_RETENTION_MS,
  VOTE_TIME_RETENTION_MS,
} from "../app/server/cleanup.server";
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

it("deletes old features of topics and removes old vote times, and keeps the votes", async () => {
  const database = await createTestDatabase();
  const db: D1Database = database.db;
  const now = Date.now();
  try {
    await db.batch([
      db.prepare(
        `INSERT INTO user (id,name,email,created_at,updated_at)
          SELECT value, value, value||'@example.test', 1, 1 FROM json_each('["host","a","b","c","d"]')`,
      ),
      db.prepare("INSERT INTO streamers (id,owner_id,handle,name) VALUES ('page','host','host_page','Host')"),
      db.prepare(`INSERT INTO entries (id,streamer_id,author_id,kind,title,options,created_at) VALUES
        ('topic','page','host','topic','Topic','[]',1), ('poll','page','host','choice','Poll','["x","y"]',1)`),
      db
        .prepare(
          `INSERT INTO stream_features (streamer_id,entry_id,featured_at) VALUES
            ('page','topic',?1), ('page','topic',?2), ('page','topic',?3)`,
        )
        .bind(now - FEATURE_RETENTION_MS - 1, now - FEATURE_RETENTION_MS, now),
      db
        .prepare(
          `INSERT INTO entry_votes (entry_id,user_id,choice,voted_at) VALUES
            ('poll','a',0,?1), ('poll','b',1,?2), ('poll','c',1,?3), ('poll','d',0,NULL)`,
        )
        .bind(now - VOTE_TIME_RETENTION_MS - 1, now - VOTE_TIME_RETENTION_MS, now),
    ]);
    await cleanExpiredData({ DB: db } as AppEnv, now);
    const features = await db
      .prepare("SELECT featured_at FROM stream_features ORDER BY featured_at")
      .all<{ featured_at: number }>();
    expect(features.results.map((row) => row.featured_at)).toEqual([now - FEATURE_RETENTION_MS, now]);
    const votes = await db
      .prepare("SELECT user_id,choice,voted_at FROM entry_votes ORDER BY user_id")
      .all<{ user_id: string; choice: number; voted_at: number | null }>();
    expect(votes.results).toEqual([
      { user_id: "a", choice: 0, voted_at: null },
      { user_id: "b", choice: 1, voted_at: now - VOTE_TIME_RETENTION_MS },
      { user_id: "c", choice: 1, voted_at: now },
      { user_id: "d", choice: 0, voted_at: null },
    ]);
    // The count triggers watch only the choice, so the totals stay.
    const counts = await db
      .prepare("SELECT choice,votes FROM entry_vote_counts WHERE entry_id='poll' ORDER BY choice")
      .all<{ choice: number; votes: number }>();
    expect(counts.results).toEqual([
      { choice: 0, votes: 2 },
      { choice: 1, votes: 2 },
    ]);
  } finally {
    await database.dispose();
  }
});
