import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, createTestDatabase, migrationFiles, type TestDatabase } from "./helpers/database";

// Seed released schema 0000-0005 (7bf63c1), then apply 0006 onward.
// Rebuilding user, streamers, entries, or entry_comments can trigger destructive ON DELETE CASCADE.

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

/** What `overlay_state` holds and how it is built, read before and after the rebuild of 0032. */
interface OverlayTable {
  rows: Record<string, unknown>[];
  columns: Record<string, unknown>[];
  foreignKeys: Record<string, unknown>[];
  objects: Record<string, unknown>[];
}
let overlayBefore: OverlayTable;
const TRANSLATION_TABLES = ["comment_translations", "entry_translations", "page_translations", "translation_attempts"];
const afterReset: Record<string, number> = {};

async function overlayTable(): Promise<OverlayTable> {
  const all = async (sql: string): Promise<Record<string, unknown>[]> => (await db.prepare(sql).all()).results;
  return {
    rows: await all("SELECT * FROM overlay_state ORDER BY streamer_id"),
    columns: await all("SELECT * FROM pragma_table_info('overlay_state')"),
    foreignKeys: await all("SELECT * FROM pragma_foreign_key_list('overlay_state')"),
    objects: await all("SELECT type,name FROM sqlite_master WHERE tbl_name='overlay_state' ORDER BY name"),
  };
}

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
        ('fan','Fan',' Fan@Example.Test ',1,NULL,?1,?1),
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
    run(
      `INSERT INTO entry_votes (entry_id,user_id,choice) VALUES ('poll','fan',2),('poll','fan2',0),('binary','fan',1)`,
    ),
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
  // Pre-0017 series retain their rows without a stored time or template.
  await applyMigrations(
    db,
    applied.filter((file: string): boolean => file < "0017"),
  );
  await db
    .prepare("INSERT INTO stream_series (id,streamer_id,written_through) VALUES ('old-series','page',1790000000000)")
    .run();
  await applyMigrations(
    db,
    applied.filter((file: string): boolean => file >= "0017" && file < "0026"),
  );
  // Entry removal records written before 0026 kept a copy of the entry title.
  await db.prepare("UPDATE user SET locale='ru' WHERE id='host'").run();
  await db.batch([
    db.prepare(
      `INSERT INTO moderation_actions (id,target_kind,target_id,action,metadata,created_at) VALUES
        ('ma-entry','entry','gone','entry_removed','{"title":"Old topic","via":"page","stepUp":"fresh"}',1),
        ('ma-page','streamer','page','freeze','{"title":"Kept","stepUp":"fresh"}',1),
        ('ma-null','entry','gone2','entry_removed',NULL,1)`,
    ),
  ]);
  await applyMigrations(
    db,
    applied.filter((file: string): boolean => file >= "0026" && file < "0030"),
  );
  // Overlay rows saved before 0030 have no layers.
  await db
    .prepare(
      `INSERT INTO overlay_state (streamer_id,air,position,message,revision,updated_at)
        VALUES ('page','{"type":"message","ref":null}','top','Back soon',9,1)`,
    )
    .run();
  await applyMigrations(
    db,
    applied.filter((file: string): boolean => file >= "0030" && file < "0032"),
  );
  // A row with a value in each column, saved before 0032 rebuilds the table.
  await db
    .prepare(
      `INSERT INTO overlay_state (streamer_id,air,preview,position,size,instant,show_results,message,message_style,
          revision,updated_at,layers,chat_test_until,layers_writes)
        SELECT id,'{"type":"topic","ref":"topic"}','{"type":"hidden","ref":null}','corner','l',1,0,'Kept','hype',
          41,1790000000001,'{"chat":{"enabled":true}}',1790000000002,'[["writer-0001",3]]'
        FROM streamers WHERE id!='page'`,
    )
    .run();
  // The test database has a trigger of another table that reads overlay_state.
  await db
    .prepare(
      `CREATE TRIGGER overlay_reader BEFORE DELETE ON streamers
        BEGIN SELECT RAISE(ABORT,'never') WHERE (SELECT count(*) FROM overlay_state) < 0; END`,
    )
    .run();
  overlayBefore = await overlayTable();
  await applyMigrations(
    db,
    applied.filter((file: string): boolean => file >= "0032" && file < "0036"),
  );
  // Stored translations for Russian and Ukrainian readers, for a different language, and a row without a translation.
  await db.batch([
    db.prepare(
      `INSERT INTO comment_translations (comment_id,locale,source_hash,text,created_at) VALUES
        ('c1','ru','h','First in English',1),('c1','uk','h','Перший',1),('c1','de','h','Erster',1),('c2','uk','h',NULL,1)`,
    ),
    db.prepare(
      `INSERT INTO entry_translations (entry_id,locale,source_hash,title,body,options,created_at) VALUES
        ('topic','uk','h','A title in English','','[]',1),('topic','ru','h','Тема','','[]',1),('topic','en','h','Topic','','[]',1)`,
    ),
  ]);
  await applyMigrations(
    db,
    applied.filter((file: string): boolean => file >= "0036" && file < "0039"),
  );
  for (const table of TRANSLATION_TABLES)
    afterReset[table] = (await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())?.n ?? -1;
  // Results from after the reset: a translation, no translation, and a name kept in Cyrillic letters.
  await db.batch([
    db.prepare(
      `INSERT INTO comment_translations (comment_id,locale,source_hash,text,created_at) VALUES
        ('c1','pl','h','Misha, cześć',1),('c1','de','h','Миша, hallo',1),('c1','ru','h','Миша, привет',1),('c2','pl','h',NULL,1)`,
    ),
    db.prepare(
      `INSERT INTO entry_translations (entry_id,locale,source_hash,title,body,options,created_at) VALUES
        ('topic','pl','h',NULL,NULL,NULL,1),('topic','de','h','Thema','Für Миша','[]',1),('topic','en','h','Topic','','[]',1)`,
    ),
    db.prepare(
      `INSERT INTO page_translations (streamer_id,source_hash,locale,value,created_at) VALUES
        ('page','a','pl',NULL,1),('page','a','de','{"title":"Миша"}',1),('page','a','en','{"title":"Misha"}',1)`,
    ),
  ]);
  await applyMigrations(
    db,
    applied.filter((file: string): boolean => file >= "0039" && file < "0040"),
  );
  // A stream with a topic link from before 0040.
  await db.batch([
    db.prepare(
      "INSERT INTO stream_events (id,streamer_id,title,starts_at,duration_min,platform,url,tz,created_at,updated_at) VALUES ('ev39','page','Old',1,60,'twitch','https://twitch.tv/host','UTC',1,1)",
    ),
    db.prepare("INSERT INTO stream_event_topics (event_id,entry_id) VALUES ('ev39','topic')"),
  ]);
  await applyMigrations(
    db,
    applied.filter((file: string): boolean => file >= "0040" && file < "0044"),
  );
  // Before 0044: one stream with a different title on each platform shows two times.
  const event = (id: string, startsAt: number, platform: string, imported: number, createdAt: number): D1PreparedStatement =>
    db
      .prepare(
        `INSERT INTO stream_events (id,streamer_id,title,starts_at,duration_min,platform,url,tz,imported,created_at,updated_at)
          VALUES (?,'page',?,?,60,?,'https://www.twitch.tv/host','UTC',?,?,1)`,
      )
      .bind(id, id, startsAt, platform, imported, createdAt);
  const source = (platform: string, externalId: string, eventId: string): D1PreparedStatement =>
    db
      .prepare(
        "INSERT INTO stream_event_sources (streamer_id,platform,external_id,event_id,url,read_at) VALUES ('page',?,?,?,'https://www.twitch.tv/host',1)",
      )
      .bind(platform, externalId, eventId);
  const hour = 3_600_000;
  await db.batch([
    event("tw1", 100 * hour, "twitch", 1, 1),
    event("yt1", 100 * hour + 10 * 60_000, "youtube", 1, 2),
    event("yt2", 102 * hour, "youtube", 1, 2),
    event("tw2", 102 * hour, "twitch", 1, 3),
    event("own", 200 * hour, "kick", 0, 1),
    // A chain: B joins A; C is 20 minutes from A and does not join B, which goes.
    event("chA", 300 * hour, "twitch", 1, 1),
    event("chB", 300 * hour + 10 * 60_000, "youtube", 1, 2),
    event("chC", 300 * hour + 20 * 60_000, "twitch", 1, 3),
    event("yt3", 200 * hour, "youtube", 1, 2),
    source("twitch", "seg1", "tw1"),
    source("youtube", "vid1", "yt1"),
    source("youtube", "vid2", "yt2"),
    source("youtube", "vid9", "tw2"),
    source("youtube", "vid3", "yt3"),
    source("twitch", "segA", "chA"),
    source("youtube", "vidB", "chB"),
    source("twitch", "segC", "chC"),
    db.prepare("INSERT INTO stream_event_topics (event_id,entry_id) VALUES ('yt1','topic')"),
  ]);
  await applyMigrations(
    db,
    applied.filter((file: string): boolean => file >= "0044"),
  );
});

afterAll(async (): Promise<void> => database.dispose());

describe("migrations 0006 onwards", (): void => {
  it("covers 0006 to 0045", (): void => {
    expect(applied.map((file: string): string => file.slice(0, 4))).toEqual([
      "0006",
      "0007",
      "0008",
      "0009",
      "0010",
      "0011",
      "0012",
      "0013",
      "0014",
      "0015",
      "0016",
      "0017",
      "0018",
      "0019",
      "0020",
      "0021",
      "0022",
      "0023",
      "0024",
      "0025",
      "0026",
      "0027",
      "0028",
      "0029",
      "0030",
      "0031",
      "0032",
      "0033",
      "0034",
      "0035",
      "0036",
      "0037",
      "0038",
      "0039",
      "0040",
      "0041",
      "0042",
      "0043",
      "0044",
      "0045",
    ]);
  });

  it("joins a stream that each platform holds with a different title into the older entry (0044)", async (): Promise<void> => {
    const rows = async (sql: string): Promise<unknown[]> => (await db.prepare(sql).all()).results;
    expect(
      await rows("SELECT id FROM stream_events WHERE id IN ('tw1','yt1','yt2','tw2','own','yt3','chA','chB','chC') ORDER BY id"),
    ).toEqual([
      { id: "chA" },
      { id: "chC" },
      { id: "own" },
      { id: "tw1" },
      { id: "tw2" },
      { id: "yt2" },
    ]);
    expect(
      await rows(
        "SELECT external_id, event_id FROM stream_event_sources WHERE external_id LIKE 'seg%' OR external_id LIKE 'vid%' ORDER BY external_id",
      ),
    ).toEqual([
      { external_id: "seg1", event_id: "tw1" },
      { external_id: "segA", event_id: "chA" },
      { external_id: "segC", event_id: "chC" },
      { external_id: "vid1", event_id: "tw1" },
      // Both entries already hold a YouTube link: they stay apart.
      { external_id: "vid2", event_id: "yt2" },
      { external_id: "vid3", event_id: "own" },
      { external_id: "vid9", event_id: "tw2" },
      { external_id: "vidB", event_id: "chA" },
    ]);
    expect(await rows("SELECT name FROM sqlite_master WHERE name='merge_0044'")).toEqual([]);
    expect(await rows("SELECT event_id FROM stream_event_topics WHERE entry_id='topic' AND event_id IN ('tw1','yt1')")).toEqual([
      { event_id: "tw1" },
    ]);
  });

  it("adds the category and the picture of a stream source (0045), empty for old rows", async (): Promise<void> => {
    expect(await db.prepare("SELECT category, image_url FROM stream_event_sources WHERE external_id='seg1'").first()).toEqual({
      category: null,
      image_url: null,
    });
  });

  it("adds the imported flag (0040) and keeps each stream and its topic links", async (): Promise<void> => {
    expect(await db.prepare("SELECT imported FROM stream_events WHERE id='ev39'").first()).toEqual({ imported: 0 });
    expect(await db.prepare("SELECT count(*) AS n FROM stream_event_topics WHERE event_id='ev39'").first()).toEqual({
      n: 1,
    });
    await expect(db.prepare("UPDATE stream_events SET imported=2 WHERE id='ev39'").run()).rejects.toThrow(/CHECK/);
    // A source keeps its row without the stream when the owner deletes the stream.
    await db
      .prepare(
        "INSERT INTO stream_event_sources (streamer_id,platform,external_id,event_id,url,read_at) VALUES ('page','twitch','seg','ev39','https://www.twitch.tv/host',1)",
      )
      .run();
    await db.prepare("DELETE FROM stream_events WHERE id='ev39'").run();
    expect(await db.prepare("SELECT event_id FROM stream_event_sources WHERE external_id='seg'").first()).toEqual({
      event_id: null,
    });
    await expect(
      db
        .prepare(
          "INSERT INTO stream_event_sources (streamer_id,platform,external_id,url,read_at) VALUES ('page','tiktok','x','https://tiktok.com/x',1)",
        )
        .run(),
    ).rejects.toThrow(/CHECK/);
  });

  it("adds comment revisions (0041) that go with their comment and hold a JSON array of mentions", async (): Promise<void> => {
    await db
      .prepare("INSERT INTO entry_comments (id,entry_id,author_id,text,created_at) VALUES ('c9','topic','fan','New',1)")
      .run();
    await expect(
      db
        .prepare(
          "INSERT INTO comment_revisions (comment_id,text,mentions,written_at,edited_at) VALUES ('c9','Old','{}',1,2)",
        )
        .run(),
    ).rejects.toThrow(/CHECK constraint failed/);
    await db
      .prepare(
        "INSERT INTO comment_revisions (comment_id,text,mentions,written_at,edited_at) VALUES ('c9','Old','[]',1,2)",
      )
      .run();
    await db.prepare("DELETE FROM entry_comments WHERE id='c9'").run();
    expect(await db.prepare("SELECT count(*) AS n FROM comment_revisions").first()).toEqual({ n: 0 });
  });

  it("adds answered marks (0043) that go with their comment and hold a stream only as a whole", async (): Promise<void> => {
    await db
      .prepare("INSERT INTO entry_comments (id,entry_id,author_id,text,created_at) VALUES ('c10','topic','fan','Q',1)")
      .run();
    await expect(
      db
        .prepare(
          "INSERT INTO comment_answers (comment_id,streamer_id,marked_at,platform) VALUES ('c10','page',1,'twitch')",
        )
        .run(),
    ).rejects.toThrow(/CHECK constraint failed/);
    await db
      .prepare(
        `INSERT INTO comment_answers (comment_id,streamer_id,marked_at,platform,url,title,started_at,offset_s)
          VALUES ('c10','page',1,'twitch','https://www.twitch.tv/host','Show',0,30)`,
      )
      .run();
    await expect(
      db.prepare("INSERT INTO answer_settings (streamer_id,lead_s) VALUES ('page',3601)").run(),
    ).rejects.toThrow(/CHECK constraint failed/);
    await db.prepare("DELETE FROM entry_comments WHERE id='c10'").run();
    expect(await db.prepare("SELECT count(*) AS n FROM comment_answers").first()).toEqual({ n: 0 });
  });

  it("deletes each stored translation (0036 and 0038), so the job makes them again", (): void => {
    for (const table of TRANSLATION_TABLES) expect(afterReset[table], table).toBe(0);
  });

  it("deletes the results without a translation and the names in Cyrillic letters (0039)", async (): Promise<void> => {
    const rows = async (sql: string): Promise<unknown[]> => (await db.prepare(sql).all()).results;
    expect(await rows("SELECT locale, text FROM comment_translations ORDER BY locale")).toEqual([
      { locale: "pl", text: "Misha, cześć" },
      { locale: "ru", text: "Миша, привет" },
    ]);
    expect(await rows("SELECT locale FROM entry_translations ORDER BY locale")).toEqual([{ locale: "en" }]);
    expect(await rows("SELECT locale FROM page_translations ORDER BY locale")).toEqual([{ locale: "en" }]);
  });

  it("rebuilds overlay_state (0032) with every row, column, default and foreign key", async (): Promise<void> => {
    expect(overlayBefore.rows).toHaveLength(2);
    expect(await overlayTable()).toEqual(overlayBefore);
    expect(await db.prepare("SELECT name FROM sqlite_master WHERE name='overlay_state_rows'").first()).toBeNull();
    expect(await db.prepare("SELECT * FROM pragma_foreign_key_check('overlay_state')").first()).toBeNull();
  });

  it("raises the layers limit (0032) to 4000 characters and keeps the other checks", async (): Promise<void> => {
    const other = "(SELECT streamer_id FROM overlay_state WHERE streamer_id!='page')";
    const set = (column: string, value: number | string | null): Promise<D1Result> =>
      db.prepare(`UPDATE overlay_state SET ${column}=? WHERE streamer_id=${other}`).bind(value).run();
    const layers = (length: number): string => JSON.stringify({ note: "x".repeat(length - 11) });
    expect(layers(4000)).toHaveLength(4000);
    await set("layers", layers(4000));
    await expect(set("layers", layers(4001))).rejects.toThrow(/constraint failed/);
    const refused: [string, number | string | null][] = [
      ["layers", "[]"],
      ["air", '{"type":"other","ref":null}'],
      ["preview", "not json"],
      ["position", "left"],
      ["size", "xl"],
      ["instant", 2],
      ["show_results", 2],
      ["message", "x".repeat(121)],
      ["message_style", "loud"],
      ["chat_test_until", -1],
      ["layers_writes", "{}"],
      ["revision", -1],
      ["updated_at", null],
    ];
    for (const [column, value] of refused) await expect(set(column, value)).rejects.toThrow(/constraint failed/);
    await expect(
      db.prepare("INSERT INTO overlay_state (streamer_id,updated_at) VALUES ('no-page',1)").run(),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/);
  });

  it("localizes existing fixed binary labels from the host locale (0031)", async (): Promise<void> => {
    expect(await db.prepare("SELECT options,binary_labels FROM entries WHERE id='binary'").first()).toEqual({
      options: '["Yes","No"]',
      binary_labels: '["Да","Нет"]',
    });
  });

  it("backfills entry activity counts (0031) without losing replies or reactions", async (): Promise<void> => {
    const result = await db
      .prepare("SELECT likes,dislikes,comments FROM entry_activity_counts WHERE entry_id='topic'")
      .first();
    expect(result).toEqual({ likes: 1, dislikes: 1, comments: 3 });
    expect(
      await db.prepare("SELECT likes,dislikes,comments FROM entry_activity_counts WHERE entry_id='poll'").first(),
    ).toEqual({ likes: 0, dislikes: 0, comments: 0 });
  });

  it("adds discussion metadata (0029) without changing existing comment text", async (): Promise<void> => {
    const row = await db.prepare("SELECT text,edited_at FROM entry_comments WHERE id='c1'").first();
    expect(row).toEqual({ text: "First", edited_at: null });
    for (const table of ["comment_mentions", "notifications", "notification_preferences"]) {
      expect(
        await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").bind(table).first(),
      ).toEqual({ name: table });
    }
  });

  it("adds overlay layers (0030) in place: old rows keep their values and read {}", async (): Promise<void> => {
    expect(
      await db
        .prepare("SELECT air,position,message,revision,layers FROM overlay_state WHERE streamer_id='page'")
        .first(),
    ).toEqual({
      air: '{"type":"message","ref":null}',
      position: "top",
      message: "Back soon",
      revision: 9,
      layers: "{}",
    });
    const column = await db
      .prepare("SELECT dflt_value, \"notnull\" AS required FROM pragma_table_info('overlay_state') WHERE name='layers'")
      .first();
    expect(column).toEqual({ dflt_value: "'{}'", required: 1 });
    const rejects = async (layers: string | null): Promise<void> => {
      await expect(
        db.prepare("UPDATE overlay_state SET layers=? WHERE streamer_id='page'").bind(layers).run(),
      ).rejects.toThrow(/constraint failed/);
    };
    await rejects("not json");
    await rejects("[]");
    await rejects('"text"');
    await rejects(null);
    await rejects(JSON.stringify({ chat: { note: "x".repeat(4000) } }));
    const layers = JSON.stringify({
      chat: { enabled: true },
      cells: { horizontal: { chat: { c: 0, r: 0, w: 3, h: 2 } } },
    });
    await db.prepare("UPDATE overlay_state SET layers=? WHERE streamer_id='page'").bind(layers).run();
    expect(await db.prepare("SELECT layers FROM overlay_state WHERE streamer_id='page'").first()).toEqual({ layers });
  });

  it("adds the chat test end and the layer write order (0030) with defaults for old rows", async (): Promise<void> => {
    expect(
      await db.prepare("SELECT chat_test_until,layers_writes FROM overlay_state WHERE streamer_id='page'").first(),
    ).toEqual({ chat_test_until: 0, layers_writes: "[]" });
    const rejects = async (column: string, value: number | string | null): Promise<void> => {
      await expect(
        db.prepare(`UPDATE overlay_state SET ${column}=? WHERE streamer_id='page'`).bind(value).run(),
      ).rejects.toThrow(/constraint failed/);
    };
    await rejects("chat_test_until", -1);
    await rejects("chat_test_until", null);
    await rejects("layers_writes", null);
    await rejects("layers_writes", "not json");
    await rejects("layers_writes", "{}");
    const pair = (index: number): [string, number] => [`${index}`.padStart(64, "w"), Number.MAX_SAFE_INTEGER];
    await rejects("layers_writes", JSON.stringify(Array.from({ length: 9 }, (_, index: number) => [`w${index}`, 1])));
    // Eight pairs of the longest writer and the largest number fit.
    const full: string = JSON.stringify(Array.from({ length: 8 }, (_, index: number) => pair(index)));
    await db
      .prepare("UPDATE overlay_state SET chat_test_until=?,layers_writes=? WHERE streamer_id='page'")
      .bind(1_800_000_000_000, full)
      .run();
  });

  it("adds data_read_at (0028) with a default for new rows", async (): Promise<void> => {
    const columns = await db
      .prepare("SELECT name, dflt_value FROM pragma_table_info('channel_connections') WHERE name='data_read_at'")
      .all();
    expect(columns.results).toEqual([{ name: "data_read_at", dflt_value: "0" }]);
  });

  it("adds channel connections (0027) that keep one channel per page and platform", async (): Promise<void> => {
    const insert = (id: string, external: string): D1PreparedStatement =>
      db
        .prepare(
          `INSERT INTO channel_connections (id,streamer_id,platform,external_id,display_name,scopes,created_at,updated_at)
            VALUES (?,'page','twitch',?,'Host','user:read:chat',1,1)`,
        )
        .bind(id, external);
    await insert("c1", "111").run();
    await expect(insert("c2", "222").run()).rejects.toThrow(/UNIQUE/);
    await db.prepare("DELETE FROM channel_connections WHERE id='c1'").run();
  });

  it("normalizes existing email addresses without changing user identity", async () => {
    expect(await db.prepare("SELECT id,email FROM user WHERE id='fan'").first()).toEqual({
      id: "fan",
      email: "fan@example.test",
    });
  });

  it("removes copied entry titles from moderation records (0026) and keeps the other keys", async (): Promise<void> => {
    const { results } = await db.prepare("SELECT id,metadata FROM moderation_actions ORDER BY id").all();
    expect(results).toEqual([
      { id: "ma-entry", metadata: '{"via":"page","stepUp":"fresh"}' },
      { id: "ma-null", metadata: null },
      { id: "ma-page", metadata: '{"title":"Kept","stepUp":"fresh"}' },
    ]);
  });

  it("backfills the vote counts (0019) from the votes already stored", async (): Promise<void> => {
    const { results } = await db
      .prepare(
        `SELECT v.entry_id, v.choice, count(*) AS stored, c.votes FROM entry_votes v
          LEFT JOIN entry_vote_counts c ON c.entry_id=v.entry_id AND c.choice=v.choice GROUP BY v.entry_id, v.choice`,
      )
      .all<{ stored: number; votes: number | null }>();
    expect(results.length).toBeGreaterThan(0);
    for (const row of results) expect(row.votes).toBe(row.stored);
  });

  it("adds the series time (0017) and template (0018) to existing series without a value", async (): Promise<void> => {
    const { results } = await db.prepare("SELECT * FROM stream_series").all();
    const added = ["hour", "minute", "title", "notes", "duration_min", "platform", "url", "tz", "repeat_days"];
    const empty = Object.fromEntries([...added, "repeat_until", "topics"].map((column: string) => [column, null]));
    expect(results).toEqual([{ id: "old-series", streamer_id: "page", written_through: 1_790_000_000_000, ...empty }]);
  });

  it("keeps every existing row, vote, reaction, comment and like", async (): Promise<void> => {
    expect(before).toMatchObject({ entries: 3, entry_votes: 3, entry_comments: 3, comment_likes: 2 });
    expect(await counts()).toEqual({ ...before, user: before.user + 1, streamers: before.streamers + 1 });
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
      db.prepare("INSERT INTO stream_series (id,streamer_id,written_through) VALUES ('series','page',1)"),
      db.prepare("INSERT INTO entry_mash (entry_id,duration_s) VALUES ('poll',30)"),
      db.prepare("INSERT INTO mash_taps (entry_id,user_id,side,taps) VALUES ('poll','fan',2,10)"),
      db.prepare(`INSERT INTO overlay_keys (streamer_id,key_hash,created_at) VALUES ('page','${"0".repeat(64)}',1)`),
    ]);
    expect(await db.prepare("SELECT is_exception FROM stream_events WHERE id='ev'").first()).toEqual({
      is_exception: 0,
    });
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
    expect(await db.prepare("SELECT count(*) AS n FROM stream_series").first()).toEqual({ n: 0 });
    expect(await db.prepare("SELECT count(*) AS n FROM overlay_keys").first()).toEqual({ n: 0 });
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
    await db.prepare("INSERT INTO streamers (id,owner_id,handle,name) VALUES ('page2','fan','fan_page','Fan')").run();
    await rejects("UPDATE streamers SET status='deleted' WHERE id='page2'");
    await rejects("UPDATE streamers SET is_official=2 WHERE id='page2'");
    await rejects("UPDATE streamers SET support_card=5 WHERE id='page2'");
    await db
      .prepare(
        "INSERT INTO entries (id,streamer_id,author_id,kind,title,created_at) VALUES ('idea','page2','fan','topic','Idea',1)",
      )
      .run();
    await rejects("UPDATE entries SET status='done' WHERE id='idea'");
    await rejects(`UPDATE entries SET status_reason='${"x".repeat(501)}' WHERE id='idea'`);
    await rejects(
      "INSERT INTO community_cards (id,streamer_id,position,title,body,button_label,button_target) VALUES ('k','page2',0,'T','B','Go','http://x.test')",
    );
    await rejects(
      "INSERT INTO streamer_links (id,streamer_id,position,kind,url) VALUES ('l','page2',4,'kofi','https://ko-fi.com/x')",
    );
    await rejects("INSERT INTO overlay_state (streamer_id,air,updated_at) VALUES ('page2','{\"type\":\"upnext\"}',1)");
    await rejects("INSERT INTO ai_interest (day,ip_hash,value) VALUES ('2026-11-05','0123456789abcdef',0)");
    await rejects(`INSERT INTO overlay_keys (streamer_id,key_hash,created_at) VALUES ('page2','${"A".repeat(64)}',1)`);
    await rejects("INSERT INTO overlay_keys (streamer_id,key_hash,created_at) VALUES ('page2','raw-key',1)");
  });
});
