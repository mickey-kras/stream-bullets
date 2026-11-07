import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, createTestDatabase, migrationFiles, type TestDatabase } from "./helpers/database";

/**
 * Applies 0000–0005, writes data the way the released app did, then applies 0006 onwards.
 * A migration that rebuilt `user`, `streamers`, `entries` or `entry_comments` would drop the old
 * table and fire ON DELETE CASCADE, so every count below would fall to zero (risk R1).
 */

const TABLES = [
  "user",
  "session",
  "account",
  "streamers",
  "entries",
  "entry_votes",
  "entry_reactions",
  "entry_comments",
  "comment_likes",
  "streamer_applications",
  "content_reports",
] as const;

let database: TestDatabase;
let db: D1Database;
let before: Record<string, number>;
let applied: string[];

async function counts(): Promise<Record<string, number>> {
  const results = await db.batch(TABLES.map((table) => db.prepare(`SELECT count(*) AS n FROM "${table}"`)));
  return Object.fromEntries(TABLES.map((table, index) => [table, (results[index].results[0] as { n: number }).n]));
}

async function seedReleasedData(): Promise<void> {
  const now = 1_790_000_000_000;
  const run = (sql: string, ...values: (string | number | null)[]): D1PreparedStatement =>
    db.prepare(sql).bind(...values);
  await db.batch([
    run(
      `INSERT INTO user (id,name,email,email_verified,image,created_at,updated_at) VALUES
        ('host','Host','host@example.test',1,'/images/avatar/host',?1,?1),
        ('fan','Fan','fan@example.test',1,NULL,?1,?1),
        ('fan2','Fan two','fan2@example.test',0,NULL,?1,?1)`,
      now,
    ),
    run(
      `INSERT INTO session (id,token,user_id,expires_at,created_at,updated_at) VALUES ('s1','token-1','fan',?1,?1,?1)`,
      now,
    ),
    run(
      `INSERT INTO account (id,account_id,provider_id,user_id,created_at,updated_at) VALUES ('a1','g-1','google','fan',?1,?1)`,
      now,
    ),
    run(
      `INSERT INTO streamers (id,owner_id,handle,name,about,avatar,background,revision)
        VALUES ('page','host','host_page','Host','About','/images/avatar/host',NULL,7)`,
    ),
    run(
      `INSERT INTO entries (id,streamer_id,author_id,kind,title,body,category,options,created_at,ends_at,revealed) VALUES
        ('topic','page','fan','topic','A topic','Body','Gaming','[]',?1,NULL,0),
        ('poll','page','host','choice','A poll','','','["A","B","C"]',?1,?2,0),
        ('binary','page','host','binary','Yes or no','','','["Yes","No"]',?1,NULL,1)`,
      now,
      now + 60_000,
    ),
    run(`INSERT INTO entry_votes (entry_id,user_id,choice) VALUES ('poll','fan',2),('poll','fan2',0),('binary','fan',1)`),
    run(`INSERT INTO entry_reactions (entry_id,user_id,value) VALUES ('topic','host',1),('topic','fan2',-1)`),
    run(
      `INSERT INTO entry_comments (id,entry_id,author_id,text,created_at,parent_id) VALUES
        ('c1','topic','fan','First',?1,NULL),('c2','topic','host','Reply',?2,'c1'),('c3','topic','fan2','Deeper',?3,'c2')`,
      now,
      now + 1,
      now + 2,
    ),
    run(`INSERT INTO comment_likes (comment_id,user_id) VALUES ('c1','host'),('c2','fan')`),
    run(
      `INSERT INTO streamer_applications (id,user_id,links,note,status,created_at,updated_at)
        VALUES ('app','fan2','["https://twitch.tv/fan2"]','','pending',?1,?1)`,
      now,
    ),
    run(
      `INSERT INTO content_reports (id,target_kind,target_id,streamer_id,reporter_id,target_author_id,reason,details,snapshot,status,created_at)
        VALUES ('r1','comment','c3','page','fan','fan2','spam','','Deeper','open',?1)`,
      now,
    ),
  ]);
}

beforeAll(async (): Promise<void> => {
  database = await createTestDatabase({ migrate: false });
  db = database.db;
  const files = await migrationFiles();
  const released = files.filter((file: string): boolean => file < "0006");
  applied = files.filter((file: string): boolean => file >= "0006");
  await applyMigrations(db, released);
  await seedReleasedData();
  before = await counts();
  await applyMigrations(db, applied);
});

afterAll(async (): Promise<void> => database.dispose());

describe("migrations 0006 onwards", (): void => {
  it("covers 0006 to 0013", (): void => {
    expect(applied.map((file: string): string => file.slice(0, 4))).toEqual([
      "0006",
      "0007",
      "0008",
      "0009",
      "0010",
      "0011",
      "0012",
      "0013",
    ]);
  });

  it("keeps every existing row, vote, reaction, comment and like", async (): Promise<void> => {
    expect(before).toMatchObject({ entries: 3, entry_votes: 3, entry_comments: 3, comment_likes: 2 });
    expect(await counts()).toEqual(before);
    const votes = await db.prepare("SELECT entry_id,user_id,choice FROM entry_votes ORDER BY entry_id,user_id").all();
    expect(votes.results).toEqual([
      { entry_id: "binary", user_id: "fan", choice: 1 },
      { entry_id: "poll", user_id: "fan", choice: 2 },
      { entry_id: "poll", user_id: "fan2", choice: 0 },
    ]);
    const thread = await db.prepare("SELECT id,parent_id,removed_at FROM entry_comments ORDER BY id").all();
    expect(thread.results).toEqual([
      { id: "c1", parent_id: null, removed_at: null },
      { id: "c2", parent_id: "c1", removed_at: null },
      { id: "c3", parent_id: "c2", removed_at: null },
    ]);
  });

  it("gives existing rows the new defaults", async (): Promise<void> => {
    const page = await db
      .prepare(
        "SELECT revision,logo,is_official,handle_changed_at,status,status_reason,support_visible,support_card FROM streamers",
      )
      .first();
    expect(page).toEqual({
      revision: 7,
      logo: null,
      is_official: 0,
      handle_changed_at: null,
      status: "active",
      status_reason: null,
      support_visible: 1,
      support_card: 0,
    });
    const account = await db.prepare("SELECT avatar_preset,locale,display_prefs FROM user WHERE id='fan'").first();
    expect(account).toEqual({ avatar_preset: null, locale: null, display_prefs: null });
    expect(await db.prepare("SELECT status FROM entries WHERE id='topic'").first()).toEqual({ status: null });
    expect(await db.prepare("SELECT admin_verified_at FROM session").first()).toEqual({ admin_verified_at: null });
  });

  it("leaves foreign keys consistent and the cascades in place", async (): Promise<void> => {
    expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    await db.batch([
      db.prepare(
        "INSERT INTO stream_events (id,streamer_id,title,starts_at,duration_min,platform,url,tz,created_at,updated_at) VALUES ('ev','page','Show',1,60,'twitch','https://twitch.tv/host','UTC',1,1)",
      ),
      db.prepare("INSERT INTO stream_event_topics (event_id,entry_id) VALUES ('ev','topic')"),
      db.prepare("INSERT INTO entry_mash (entry_id,duration_s) VALUES ('poll',30)"),
      db.prepare("INSERT INTO mash_taps (entry_id,user_id,side,taps) VALUES ('poll','fan',2,10)"),
    ]);
    expect(await db.prepare("SELECT is_exception FROM stream_events WHERE id='ev'").first()).toEqual({ is_exception: 0 });
    await expect(db.prepare("UPDATE stream_events SET is_exception=2 WHERE id='ev'").run()).rejects.toThrow(/CHECK/);
    await db.prepare("DELETE FROM entries WHERE id='poll'").run();
    const left = await db.batch([
      db.prepare("SELECT count(*) AS n FROM entry_mash"),
      db.prepare("SELECT count(*) AS n FROM mash_taps"),
      db.prepare("SELECT count(*) AS n FROM entry_votes WHERE entry_id='poll'"),
    ]);
    expect(left.map((result) => (result.results[0] as { n: number }).n)).toEqual([0, 0, 0]);
    await db.prepare("DELETE FROM user WHERE id='host'").run();
    expect(await db.prepare("SELECT count(*) AS n FROM stream_events").first()).toEqual({ n: 0 });
    expect(await db.prepare("SELECT count(*) AS n FROM entries").first()).toEqual({ n: 0 });
  });

  it("enforces the new CHECK constraints added in place", async (): Promise<void> => {
    const rejects = async (sql: string): Promise<void> => {
      await expect(db.prepare(sql).run()).rejects.toThrow(/CHECK constraint failed/);
    };
    await rejects("UPDATE user SET avatar_preset=18 WHERE id='fan'");
    await rejects("UPDATE user SET locale='xx' WHERE id='fan'");
    await rejects("UPDATE user SET display_prefs='not json' WHERE id='fan'");
    await db.prepare("UPDATE user SET avatar_preset=17, locale='pt-BR', display_prefs='{}' WHERE id='fan'").run();
    await db.prepare(
      "INSERT INTO streamers (id,owner_id,handle,name) VALUES ('page2','fan','fan_page','Fan')",
    ).run();
    await rejects("UPDATE streamers SET status='deleted' WHERE id='page2'");
    await rejects("UPDATE streamers SET is_official=2 WHERE id='page2'");
    await rejects("UPDATE streamers SET support_card=5 WHERE id='page2'");
    await db.prepare(
      "INSERT INTO entries (id,streamer_id,author_id,kind,title,created_at) VALUES ('idea','page2','fan','topic','Idea',1)",
    ).run();
    await rejects("UPDATE entries SET status='done' WHERE id='idea'");
    await rejects(`UPDATE entries SET status_reason='${"x".repeat(501)}' WHERE id='idea'`);
    await rejects(
      "INSERT INTO community_cards (id,streamer_id,position,title,body,button_label,button_target) VALUES ('k','page2',0,'T','B','Go','http://x.test')",
    );
    await rejects("INSERT INTO streamer_links (id,streamer_id,position,kind,url) VALUES ('l','page2',4,'kofi','https://ko-fi.com/x')");
    await rejects("INSERT INTO overlay_state (streamer_id,air,updated_at) VALUES ('page2','{\"type\":\"upnext\"}',1)");
    await rejects("INSERT INTO ai_interest (day,ip_hash,value) VALUES ('2026-11-05','0123456789abcdef',0)");
  });
});
