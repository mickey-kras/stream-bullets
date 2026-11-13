import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AppEnv } from "../app/env";
import type { CommentMention } from "../app/types";
import { getCommentThread, listComments, mutateComment } from "../app/server/comments.server";
import { mutateEntry } from "../app/server/data.server";
import {
  listNotifications, markNotification, mentionCandidates, notificationStatements, saveNotificationPreferences,
} from "../app/server/discussion-notifications.server";
import { commentActionSchema, entryActionSchema } from "../app/server/validation";
import { createTestDatabase, type TestDatabase } from "./helpers/database";

let database: TestDatabase;
let env: AppEnv;
let entryId: string;
let otherEntryId: string;

beforeAll(async (): Promise<void> => {
  database = await createTestDatabase();
  env = { DB: database.db } as AppEnv;
});
afterAll(async (): Promise<void> => database.dispose());
beforeEach(async (): Promise<void> => {
  entryId = crypto.randomUUID();
  otherEntryId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM user"),
    env.DB.prepare("DELETE FROM app_rate_limits"),
    ...["host", "fan", "other", "private", "remote"].map((id: string): D1PreparedStatement => env.DB.prepare(
      "INSERT INTO user (id,name,email,created_at,updated_at) VALUES (?,?,?,?,?)",
    ).bind(id, id, `${id}@secret.test`, 1, 1)),
    env.DB.prepare("INSERT INTO streamers (id,owner_id,handle,name) VALUES ('page','host','host','Host'),('remote-page','remote','remote','Remote')"),
    env.DB.prepare(`INSERT INTO entries (id,streamer_id,author_id,kind,title,created_at)
      VALUES (?,'page','host','topic','Topic',1),(?,'remote-page','remote','topic','Remote',1)`)
      .bind(entryId, otherEntryId),
  ]);
});

async function seedComment(authorId = "fan", entry = entryId, parentId: string | null = null): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO entry_comments (id,entry_id,author_id,text,created_at,parent_id) VALUES (?,?,?,?,?,?)")
    .bind(id, entry, authorId, "Original", Date.now(), parentId).run();
  return id;
}

async function post(authorId: string, text: string, parentId: string | null = null, mentions: CommentMention[] = []): Promise<string> {
  const result = await mutateEntry(env, authorId, "page", { action: "comment", id: entryId, text, parentId, mentions });
  return result.id;
}

async function notificationCount(): Promise<number> {
  const result = await env.DB.prepare("SELECT count(*) AS count FROM notifications").first<{ count: number }>();
  return result?.count ?? 0;
}

describe("comment editing and mentions", (): void => {
  it("edits own nested replies without changing parent or creation time and records the marker", async (): Promise<void> => {
    const root = await seedComment("host");
    const child = await seedComment("fan", entryId, root);
    const before = await getCommentThread(env, child, "fan");
    await mutateComment(env, "fan", { action: "edit", id: child, text: "Updated" });
    const after = await getCommentThread(env, child, "fan");
    expect(after.comment).toMatchObject({ text: "Updated", parentId: root, createdAt: before.comment.createdAt });
    expect(after.comment.editedAt).toBeGreaterThan(0);
    expect(after.thread.replies.map((comment) => comment.id)).toContain(child);
    await expect(mutateComment(env, "host", { action: "edit", id: child, text: "Hijacked" })).rejects.toMatchObject({ status: 403 });
    await expect(mutateComment(env, "other", { action: "edit", id: child, text: "Hijacked" })).rejects.toMatchObject({ status: 403 });
  });

  it("only discovers public profiles and participants in this community, without private fields", async (): Promise<void> => {
    await seedComment("other");
    await seedComment("private", otherEntryId);
    const users = await mentionCandidates(env, "page", "e");
    expect(users.map((user) => user.id)).toContain("other");
    expect(users.map((user) => user.id)).not.toContain("private");
    expect(users.map((user) => user.id)).toContain("remote");
    expect(JSON.stringify(users)).not.toContain("email");
    expect(JSON.stringify(users)).not.toContain("secret.test");
    await expect(post("fan", "@private", null, [{ userId: "private", start: 0, end: 8 }])).rejects.toMatchObject({ status: 400 });
  });

  it("validates selected identities, ranges, overlaps and duplicate users without parsing display names", async (): Promise<void> => {
    const id = await post("fan", "  @host hello", null, [{ userId: "host", start: 2, end: 7 }]);
    expect((await getCommentThread(env, id, "fan")).comment).toMatchObject({ text: "  @host hello", mentions: [{ userId: "host", start: 2, end: 7 }] });
    await expect(post("fan", "@host", null, [{ userId: "remote", start: 0, end: 5 }])).rejects.toMatchObject({ status: 400 });
    await expect(post("fan", "@host", null, [{ userId: "host", start: 0, end: 200 }])).rejects.toMatchObject({ status: 400 });
    await expect(post("fan", "@host @host", null, [{ userId: "host", start: 0, end: 5 }, { userId: "host", start: 6, end: 11 }])).rejects.toMatchObject({ status: 400 });
    expect(commentActionSchema.safeParse({ action: "edit", id, text: "\u0000" }).success).toBe(false);
    expect(entryActionSchema.safeParse({ action: "comment", id, text: " ", mentions: [] }).success).toBe(false);
    expect(entryActionSchema.safeParse({ action: "comment", id, text: "x", mentions: Array.from({ length: 6 }, () => ({ userId: "host", start: 0, end: 1 })) }).success).toBe(false);
  });

  it("preserves stable selected mentions on unrelated edits after account renaming", async (): Promise<void> => {
    const id = await post("fan", "@host hi", null, [{ userId: "host", start: 0, end: 5 }]);
    await env.DB.prepare("UPDATE user SET name='Renamed' WHERE id='host'").run();
    await mutateComment(env, "fan", { action: "edit", id, text: "Hello @host again", mentions: [{ userId: "host", start: 6, end: 11 }] });
    expect((await getCommentThread(env, id, "fan")).comment.mentions).toEqual([{ userId: "host", start: 6, end: 11 }]);
    expect((await listNotifications(env, "host")).notifications).toHaveLength(1);
    await expect(post("fan", "@host new", null, [{ userId: "host", start: 0, end: 5 }])).rejects.toMatchObject({ status: 400 });
    await expect(mutateComment(env, "fan", { action: "edit", id, text: "@Wrong", mentions: [{ userId: "host", start: 0, end: 6 }] })).rejects.toMatchObject({ status: 400 });
  });

  it("cannot edit removed comments or reply across communities or to removed parents", async (): Promise<void> => {
    const root = await seedComment("host");
    const reply = await seedComment("fan", entryId, root);
    await mutateComment(env, "host", { action: "delete", id: root });
    await expect(mutateComment(env, "host", { action: "edit", id: root, text: "Restored" })).rejects.toMatchObject({ status: 404 });
    await expect(post("fan", "Reply", root)).rejects.toMatchObject({ status: 400 });
    const remote = await seedComment("private", otherEntryId);
    await expect(post("fan", "Reply", remote)).rejects.toMatchObject({ status: 400 });
    expect((await getCommentThread(env, reply, "fan")).rootId).toBe(root);
  });
});

describe("persistent discussion notifications", (): void => {
  it("delivers one reply when the parent author is also mentioned and preserves read state", async (): Promise<void> => {
    const parent = await seedComment("host");
    const child = await post("fan", "@host reply", parent, [{ userId: "host", start: 0, end: 5 }]);
    const snapshot = await listNotifications(env, "host");
    expect(snapshot.unreadCount).toBe(1);
    expect(snapshot.notifications).toHaveLength(1);
    expect(snapshot.notifications[0]).toMatchObject({ kind: "reply", commentId: child, read: false });
    expect(snapshot.notifications[0].href).toBe(`/@host?view=topics&entry=${entryId}&comment=${child}`);
    await env.DB.batch(notificationStatements(env, child, "fan", Date.now()));
    expect(await notificationCount()).toBe(1);
    const id = snapshot.notifications[0].id;
    await expect(markNotification(env, "fan", id, true)).rejects.toMatchObject({ status: 404 });
    await markNotification(env, "host", id, true);
    expect((await listNotifications(env, "host")).unreadCount).toBe(0);
    expect((await listNotifications(env, "host")).notifications[0].read).toBe(true);
    await markNotification(env, "host", id, false);
    expect((await listNotifications(env, "host")).unreadCount).toBe(1);
  });

  it("delivers an explicit parent mention when reply delivery is disabled", async (): Promise<void> => {
    const parent = await seedComment("host");
    await saveNotificationPreferences(env, "host", { replies: false, mentions: true });
    const id = await post("fan", "@host reply", parent, [{ userId: "host", start: 0, end: 5 }]);
    const inbox = await listNotifications(env, "host");
    expect(inbox.notifications).toHaveLength(1);
    expect(inbox.notifications[0]).toMatchObject({ kind: "mention", commentId: id });
    await saveNotificationPreferences(env, "host", { replies: true, mentions: false });
    const second = await post("fan", "@host reply", parent, [{ userId: "host", start: 0, end: 5 }]);
    const next = await listNotifications(env, "host");
    expect(next.notifications.find((item) => item.commentId === second)?.kind).toBe("reply");
  });

  it("suppresses self delivery and honors persistent preferences for new events", async (): Promise<void> => {
    const parent = await seedComment("host");
    await post("host", "Self reply", parent);
    expect(await notificationCount()).toBe(0);
    await saveNotificationPreferences(env, "host", { replies: false, mentions: false });
    await post("fan", "@host reply", parent, [{ userId: "host", start: 0, end: 5 }]);
    expect(await notificationCount()).toBe(0);
    expect((await listNotifications(env, "host")).preferences).toEqual({ replies: false, mentions: false });
    await saveNotificationPreferences(env, "host", { replies: true, mentions: true });
    await post("fan", "@host hello", null, [{ userId: "host", start: 0, end: 5 }]);
    expect((await listNotifications(env, "host")).notifications[0].kind).toBe("mention");
  });

  it("does not notify on edits and retracts removed mentions and deleted comments", async (): Promise<void> => {
    const id = await post("fan", "@host hi", null, [{ userId: "host", start: 0, end: 5 }]);
    await mutateComment(env, "fan", { action: "edit", id, text: "Removed mention" });
    expect(await notificationCount()).toBe(0);
    await mutateComment(env, "fan", { action: "edit", id, text: "@host new", mentions: [{ userId: "host", start: 0, end: 5 }] });
    expect(await notificationCount()).toBe(0);
    const parent = await seedComment("host");
    const child = await post("fan", "Reply", parent);
    expect(await notificationCount()).toBe(1);
    await mutateComment(env, "fan", { action: "delete", id: child });
    expect(await notificationCount()).toBe(0);
  });

  it("hides suspended content from notifications and exact links while preserving owner access", async (): Promise<void> => {
    const parent = await seedComment("fan");
    const id = await post("other", "Reply", parent);
    expect((await listNotifications(env, "fan")).notifications).toHaveLength(1);
    await env.DB.prepare("UPDATE streamers SET status='suspended' WHERE id='page'").run();
    expect((await listNotifications(env, "fan")).notifications).toEqual([]);
    expect((await listNotifications(env, "fan")).unreadCount).toBe(0);
    await expect(getCommentThread(env, id, "fan")).rejects.toMatchObject({ status: 404 });
    expect((await getCommentThread(env, id, "host")).comment.id).toBe(id);
    await expect(mutateComment(env, "other", { action: "edit", id, text: "Hidden edit" })).rejects.toMatchObject({ status: 404 });
  });

  it("limits per-sender notification spam and removes expired records", async (): Promise<void> => {
    const now = Date.now();
    const ids = Array.from({ length: 12 }, (): string => crypto.randomUUID());
    for (const id of ids) {
      await env.DB.prepare("INSERT INTO entry_comments (id,entry_id,author_id,text,created_at,parent_id) VALUES (?,?,?,'Reply',?,?)")
        .bind(id, entryId, "fan", now, await seedComment("host")).run();
      await env.DB.batch(notificationStatements(env, id, "fan", now));
    }
    expect(await notificationCount()).toBe(10);
    await env.DB.prepare("UPDATE notifications SET created_at=?").bind(now - 91 * 86_400_000).run();
    expect((await listNotifications(env, "host")).notifications).toEqual([]);
    await env.DB.batch(notificationStatements(env, ids[11], "fan", now + 3_600_000));
    expect(await notificationCount()).toBe(1);
  });

  it("does not reset sender bounds when comments are deleted", async (): Promise<void> => {
    const now = Date.now();
    const parent = await seedComment("host");
    for (let index = 0; index < 12; index += 1) {
      const id = await seedComment("fan", entryId, parent);
      await env.DB.batch(notificationStatements(env, id, "fan", now));
      await env.DB.prepare("DELETE FROM entry_comments WHERE id=?").bind(id).run();
    }
    const counter = await env.DB.prepare("SELECT count FROM app_rate_limits WHERE key=?")
      .bind('notify-recipient:["fan","host"]').first<{ count: number }>();
    expect(counter?.count).toBe(10);
    const id = await seedComment("fan", entryId, parent);
    await env.DB.batch(notificationStatements(env, id, "fan", now));
    expect(await notificationCount()).toBe(0);
  });

  it("bounds recipient retention and pages with stable cursors", async (): Promise<void> => {
    const parent = await seedComment("host");
    const child = await seedComment("fan", entryId, parent);
    const now = Date.now();
    const statements: D1PreparedStatement[] = [];
    for (let index = 0; index < 205; index += 1) {
      const id = crypto.randomUUID();
      statements.push(env.DB.prepare("INSERT INTO entry_comments (id,entry_id,author_id,text,created_at) VALUES (?,?,?,'Reply',?)")
        .bind(id, entryId, "fan", now - index));
      statements.push(env.DB.prepare("INSERT INTO notifications (id,user_id,actor_id,comment_id,kind,created_at) VALUES (?,'host','fan',?,'reply',?)")
        .bind(crypto.randomUUID().replaceAll("-", ""), id, now - index));
    }
    await env.DB.batch(statements);
    await env.DB.prepare("UPDATE notifications SET created_at=created_at-3600001").run();
    await env.DB.batch(notificationStatements(env, child, "fan", now));
    expect(await notificationCount()).toBe(200);
    const first = await listNotifications(env, "host");
    const second = await listNotifications(env, "host", first.nextCursor);
    expect(first.notifications).toHaveLength(50);
    expect(second.notifications).toHaveLength(50);
    expect(new Set([...first.notifications, ...second.notifications].map((item) => item.id)).size).toBe(100);
    await expect(listNotifications(env, "host", "bad")).rejects.toMatchObject({ status: 400 });
    expect((await listComments(env, entryId, "host", { sort: "newest", cursor: null, view: "flat" })).comments.length).toBe(100);
  });
});
