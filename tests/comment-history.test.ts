import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../app/env";
import type { CommentRevision } from "../app/types";
import { deleteAccount, exportAccount } from "../app/server/account.server";
import { cleanExpiredData } from "../app/server/cleanup.server";
import { deleteComment, mutateComment, REVISION_RETENTION_MS } from "../app/server/comments.server";
import { apiCaller } from "./helpers/api";
import { createTestDatabase, type TestDatabase } from "./helpers/database";

const origin = "https://stream.example.test";
const secret = "test-only-secret-1f0c3f1e9a2b4c5d8e7f6a5b4c3d2e1f";
const page = "20000000-0000-4000-8000-000000000001";
const otherPage = "20000000-0000-4000-8000-000000000002";
const topic = "20000000-0000-4000-8000-000000000003";
const otherTopic = "20000000-0000-4000-8000-000000000004";
const users = ["owner", "author", "viewer", "rival", "admin"];

let database: TestDatabase;
let env: AppEnv;
const { call } = apiCaller(() => env, origin, secret);

beforeAll(async (): Promise<void> => {
  database = await createTestDatabase();
  env = {
    DB: database.db,
    IMAGES: database.bucket,
    APP_ORIGIN: origin,
    BETTER_AUTH_SECRET: secret,
    ADMIN_EMAILS: "admin@example.test",
    ADMIN_STEP_UP: "enforce",
  } as AppEnv;
});
afterAll(async (): Promise<void> => database.dispose());
beforeEach(async (): Promise<void> => {
  vi.restoreAllMocks();
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM user"),
    env.DB.prepare("DELETE FROM app_rate_limits"),
    env.DB.prepare(
      `INSERT INTO user (id,name,email,email_verified,created_at,updated_at)
        SELECT value, value, value||'@example.test', 1, ?1, ?1 FROM json_each(?2)`,
    ).bind(now, JSON.stringify(users)),
    env.DB.prepare(
      `INSERT INTO session (id,token,user_id,expires_at,created_at,updated_at)
        SELECT 's-'||value, value||'-session-token', value, ?1, ?2, ?2 FROM json_each(?3)`,
    ).bind(now + 86_400_000, now, JSON.stringify(users)),
    env.DB.prepare(
      "INSERT INTO streamers (id,owner_id,handle,name) VALUES (?,'owner','owner_page','Owner'),(?,'rival','rival_page','Rival')",
    ).bind(page, otherPage),
    env.DB.prepare(
      "INSERT INTO entries (id,streamer_id,author_id,kind,title,created_at) VALUES (?,?,'owner','topic','Topic',1),(?,?,'rival','topic','Rival topic',1)",
    ).bind(topic, page, otherTopic, otherPage),
  ]);
});

async function seedComment(entryId = topic, authorId = "author", parentId: string | null = null): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO entry_comments (id,entry_id,author_id,text,created_at,parent_id) VALUES (?,?,?,'First',1000,?)",
  )
    .bind(id, entryId, authorId, parentId)
    .run();
  return id;
}

async function edit(id: string, text: string, authorId = "author"): Promise<void> {
  await mutateComment(env, authorId, { action: "edit", id, text });
}

async function revisionCount(id: string): Promise<number> {
  const row = await env.DB.prepare("SELECT count(*) AS n FROM comment_revisions WHERE comment_id=?")
    .bind(id)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

async function history(id: string, user?: string): Promise<Response> {
  return call("GET", `comments/${id}/history`, user ? { user } : {});
}

describe("comment history", (): void => {
  it("stores each earlier text with the time it was written and edited, oldest first", async (): Promise<void> => {
    const id = await seedComment();
    await edit(id, "Second");
    await edit(id, "Second");
    await edit(id, "Third");
    const response = await history(id, "owner");
    expect(response.status).toBe(200);
    const { revisions } = await response.json<{ revisions: CommentRevision[] }>();
    expect(revisions.map((revision: CommentRevision) => revision.text)).toEqual(["First", "Second"]);
    expect(revisions[0].writtenAt).toBe(1000);
    expect(revisions[1].writtenAt).toBe(revisions[0].editedAt);
    expect(revisions[1].editedAt).toBeGreaterThanOrEqual(revisions[0].editedAt);
  });

  it("keeps the mentions of an earlier text", async (): Promise<void> => {
    const id = await seedComment();
    await env.DB.prepare("UPDATE entry_comments SET text='@owner hi' WHERE id=?").bind(id).run();
    await env.DB.prepare("INSERT INTO comment_mentions (comment_id,user_id,start,end) VALUES (?,'owner',0,6)")
      .bind(id)
      .run();
    await edit(id, "Plain");
    const { revisions } = await (await history(id, "owner")).json<{ revisions: CommentRevision[] }>();
    expect(revisions).toMatchObject([{ text: "@owner hi", mentions: [{ userId: "owner", start: 0, end: 6 }] }]);
  });

  it("answers 404 to the author, a viewer, the owner of a different page and a signed-out reader", async (): Promise<void> => {
    const id = await seedComment();
    await edit(id, "Second");
    for (const user of ["author", "viewer", "rival", undefined]) expect((await history(id, user)).status).toBe(404);
    expect((await history(crypto.randomUUID(), "owner")).status).toBe(404);
  });

  it("asks an admin for a fresh step-up, then shows the history", async (): Promise<void> => {
    const id = await seedComment();
    await edit(id, "Second");
    const refused = await history(id, "admin");
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: "keys_required" });
    env.ADMIN_STEP_UP = "report";
    try {
      const response = await history(id, "admin");
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ revisions: [{ text: "First" }] });
    } finally {
      env.ADMIN_STEP_UP = "enforce";
    }
  });

  it("keeps pages apart: each owner reads only the history of their own page", async (): Promise<void> => {
    const own = await seedComment();
    const other = await seedComment(otherTopic);
    await edit(own, "Own edit");
    await edit(other, "Other edit");
    expect((await history(own, "owner")).status).toBe(200);
    expect((await history(other, "owner")).status).toBe(404);
    expect(await (await history(other, "rival")).json()).toMatchObject({ revisions: [{ text: "First" }] });
  });

  it("deletes the history of a removed comment, also when its placeholder stays for the replies", async (): Promise<void> => {
    const alone = await seedComment();
    const parent = await seedComment();
    await seedComment(topic, "viewer", parent);
    await edit(alone, "Second");
    await edit(parent, "Second");
    await deleteComment(env, "author", alone);
    await deleteComment(env, "author", parent);
    expect(await revisionCount(alone)).toBe(0);
    expect(await revisionCount(parent)).toBe(0);
    expect((await history(parent, "owner")).status).toBe(404);
  });

  it("deletes the history with the account of the author", async (): Promise<void> => {
    const id = await seedComment();
    await edit(id, "Second");
    await deleteAccount(env, "author");
    expect(await revisionCount(id)).toBe(0);
  });

  it("deletes earlier texts 90 days after the edit", async (): Promise<void> => {
    const old = await seedComment();
    const recent = await seedComment();
    await edit(old, "Second");
    await edit(recent, "Second");
    const now = Date.now();
    await env.DB.prepare("UPDATE comment_revisions SET edited_at=? WHERE comment_id=?")
      .bind(now - REVISION_RETENTION_MS - 1, old)
      .run();
    await cleanExpiredData(env, now);
    expect(await revisionCount(old)).toBe(0);
    expect(await revisionCount(recent)).toBe(1);
  });

  it("adds the earlier texts to the data export of the author", async (): Promise<void> => {
    const id = await seedComment();
    await edit(id, "Second");
    const data = await exportAccount(env, "author");
    const comment = data.comments.find((item) => item.id === id);
    expect(comment?.text).toBe("Second");
    expect(comment?.editedAt).not.toBeNull();
    expect(comment?.earlierTexts).toEqual([
      { text: "First", writtenAt: new Date(1000).toISOString(), editedAt: comment?.editedAt },
    ]);
  });
});

describe("the replies of a thread", (): void => {
  async function replies(path: string): Promise<Response> {
    return call("GET", path);
  }

  it("pages the replies through the API and refuses a bad anchor", async (): Promise<void> => {
    const root = await seedComment();
    const first = await seedComment(topic, "viewer", root);
    const second = await seedComment(topic, "rival", first);
    await env.DB.prepare("UPDATE entry_comments SET created_at=2000 WHERE id=?").bind(second).run();
    const response = await replies(`comments/${root}/replies?after=1000.${first}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ replies: [{ id: second, parentAuthor: "viewer" }], earlierReplies: 1 });
    expect((await replies(`comments/${root}/replies?after=1000.${first}&before=2000.${second}`)).status).toBe(400);
    expect((await replies(`comments/${root}/replies?after=${first}`)).status).toBe(400);
    expect((await replies(`comments/${root}/replies?from=x.${first}`)).status).toBe(400);
    expect((await replies(`comments/${root}/replies?cursor=x`)).status).toBe(400);
    // A reply is no thread, and a thread on a hidden page is not found.
    expect((await replies(`comments/${first}/replies`)).status).toBe(404);
    await env.DB.prepare("UPDATE streamers SET status='suspended' WHERE id=?").bind(page).run();
    expect((await replies(`comments/${root}/replies`)).status).toBe(404);
  });
});
