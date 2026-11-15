import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./helpers/database";

let database: TestDatabase;
let db: D1Database;

beforeAll(async (): Promise<void> => {
  database = await createTestDatabase();
  db = database.db;
});
afterAll(async (): Promise<void> => database.dispose());
beforeEach(async (): Promise<void> => {
  await db.batch([
    db.prepare("DELETE FROM user WHERE id IN ('host','fan')"),
    db.prepare("INSERT INTO user (id,name,email,created_at,updated_at) VALUES ('host','Host','host@example.test',1,1),('fan','Fan','fan@example.test',1,1)"),
    db.prepare("INSERT INTO streamers (id,owner_id,handle,name) VALUES ('page','host','host_page','Host')"),
    db.prepare("INSERT INTO entries (id,streamer_id,author_id,kind,title,created_at) VALUES ('topic','page','host','topic','Topic',1),('second','page','host','topic','Second',2)"),
  ]);
});

async function counts(entryId = "topic"): Promise<unknown> {
  return db.prepare("SELECT likes,dislikes,comments FROM entry_activity_counts WHERE entry_id=?").bind(entryId).first();
}

describe("entry activity counters", (): void => {
  it("tracks reaction inserts, upserts, moves, removals, and account cascades", async (): Promise<void> => {
    expect(await counts()).toEqual({ likes: 0, dislikes: 0, comments: 0 });
    await db.prepare("INSERT INTO entry_reactions VALUES ('topic','fan',1)").run();
    expect(await counts()).toEqual({ likes: 1, dislikes: 0, comments: 0 });
    await db.prepare("INSERT INTO entry_reactions VALUES ('topic','fan',-1) ON CONFLICT(entry_id,user_id) DO UPDATE SET value=excluded.value").run();
    expect(await counts()).toEqual({ likes: 0, dislikes: 1, comments: 0 });
    await db.prepare("UPDATE entry_reactions SET entry_id='second' WHERE user_id='fan'").run();
    expect(await counts()).toEqual({ likes: 0, dislikes: 0, comments: 0 });
    expect(await counts("second")).toEqual({ likes: 0, dislikes: 1, comments: 0 });
    await db.prepare("DELETE FROM entry_reactions WHERE user_id='fan'").run();
    expect(await counts("second")).toEqual({ likes: 0, dislikes: 0, comments: 0 });
    await db.prepare("INSERT INTO entry_reactions VALUES ('topic','fan',1)").run();
    await db.prepare("DELETE FROM user WHERE id='fan'").run();
    expect(await counts()).toEqual({ likes: 0, dislikes: 0, comments: 0 });
  });

  it("counts visible comments through edits, tombstones, restoration, and cascades", async (): Promise<void> => {
    await db.prepare("INSERT INTO entry_comments (id,entry_id,author_id,text,created_at) VALUES ('parent','topic','fan','Parent',1)").run();
    await db.prepare("INSERT INTO entry_comments (id,entry_id,author_id,text,created_at,parent_id) VALUES ('reply','topic','host','Reply',2,'parent')").run();
    expect(await counts()).toEqual({ likes: 0, dislikes: 0, comments: 2 });
    await db.prepare("UPDATE entry_comments SET removed_at=3 WHERE id='parent'").run();
    expect(await counts()).toEqual({ likes: 0, dislikes: 0, comments: 1 });
    await db.prepare("UPDATE entry_comments SET text='Edited' WHERE id='reply'").run();
    expect(await counts()).toEqual({ likes: 0, dislikes: 0, comments: 1 });
    await db.prepare("UPDATE entry_comments SET removed_at=NULL WHERE id='parent'").run();
    expect(await counts()).toEqual({ likes: 0, dislikes: 0, comments: 2 });
    await db.prepare("DELETE FROM user WHERE id='fan'").run();
    expect(await counts()).toEqual({ likes: 0, dislikes: 0, comments: 0 });
  });

  it("removes counts when an entry is deleted and rejects malformed binary labels", async (): Promise<void> => {
    await db.prepare("INSERT INTO entry_reactions VALUES ('topic','fan',1)").run();
    await db.prepare("DELETE FROM entries WHERE id='topic'").run();
    expect(await counts()).toBeNull();
    const insert = db.prepare("INSERT INTO entries (id,streamer_id,author_id,kind,title,options,binary_labels,created_at) VALUES ('binary','page','host','binary','Poll','[\"Yes\",\"No\"]',?,1)");
    for (const labels of ['["One"]', '["One","One"]', '["One",2]', '[" ","Two"]']) {
      await expect(insert.bind(labels).run()).rejects.toThrow(/CHECK/);
    }
    await insert.bind('["Да","Нет"]').run();
    expect(await db.prepare("SELECT binary_labels FROM entries WHERE id='binary'").first("binary_labels")).toBe('["Да","Нет"]');
  });
});
