import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./helpers/database";

/** Migration 0019: triggers keep `entry_vote_counts` equal to a count of `entry_votes`. */

let database: TestDatabase;
let db: D1Database;

async function counts(entryId: string): Promise<Record<number, number>> {
  const { results } = await db
    .prepare("SELECT choice, votes FROM entry_vote_counts WHERE entry_id=? AND votes > 0 ORDER BY choice")
    .bind(entryId)
    .all<{ choice: number; votes: number }>();
  return Object.fromEntries(results.map((row) => [row.choice, row.votes]));
}

async function vote(entryId: string, userId: string, choice: number): Promise<void> {
  await db
    .prepare(
      "INSERT INTO entry_votes (entry_id,user_id,choice) VALUES (?,?,?) ON CONFLICT(entry_id,user_id) DO UPDATE SET choice=excluded.choice",
    )
    .bind(entryId, userId, choice)
    .run();
}

beforeAll(async (): Promise<void> => {
  database = await createTestDatabase();
  db = database.db;
  await db.batch([
    db.prepare(
      `INSERT INTO user (id,name,email,email_verified,created_at,updated_at)
        SELECT value, value, value||'@example.test', 1, 1, 1 FROM json_each('["host","a","b","c"]')`,
    ),
    db.prepare("INSERT INTO streamers (id,owner_id,handle,name) VALUES ('s','host','host_page','Host')"),
    db.prepare(`INSERT INTO entries (id,streamer_id,author_id,kind,title,options,created_at)
      VALUES ('p1','s','host','choice','Pick','["x","y","z"]',1), ('p2','s','host','choice','Other','["x","y"]',1)`),
  ]);
});

afterAll(async (): Promise<void> => database.dispose());

describe("vote counts", () => {
  it("follow new votes, changed votes and unchanged re-votes", async (): Promise<void> => {
    await vote("p1", "a", 0);
    await vote("p1", "b", 0);
    await vote("p1", "c", 2);
    expect(await counts("p1")).toEqual({ 0: 2, 2: 1 });
    await vote("p1", "b", 1);
    await vote("p1", "c", 2);
    expect(await counts("p1")).toEqual({ 0: 1, 1: 1, 2: 1 });
  });

  it("drop the votes of a deleted account and of a deleted entry", async (): Promise<void> => {
    await vote("p2", "a", 1);
    await db.prepare("DELETE FROM user WHERE id='a'").run();
    expect(await counts("p1")).toEqual({ 1: 1, 2: 1 });
    expect(await counts("p2")).toEqual({});
    await db.prepare("DELETE FROM entries WHERE id='p1'").run();
    expect((await db.prepare("SELECT count(*) AS n FROM entry_vote_counts WHERE entry_id='p1'").first("n"))).toBe(0);
  });
});
