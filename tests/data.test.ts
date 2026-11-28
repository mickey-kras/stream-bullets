import { Buffer as NodeBuffer } from "node:buffer";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../app/env";
import type { Comment, CommentThread, Streamer } from "../app/types";
import {
  consumeMutationQuota,
  getEntry,
  getOverlaySnapshot,
  getOwnStreamer,
  getStreamer,
  listEntries,
  listStreamers,
  mutateEntry,
  saveStreamer,
} from "../app/server/data.server";
import { getCommentThread, listComments, listReplies, mutateComment } from "../app/server/comments.server";
import { createTestDatabase } from "./helpers/database";
import type { TestDatabase } from "./helpers/database";
import { startOfQuotaWindow } from "./helpers/quota";

// Workers globals declare Buffer as any; use the Node constructor type for this Node test.
const Buffer: BufferConstructor = NodeBuffer as BufferConstructor;

let database: TestDatabase;
let env: AppEnv;
let streamer: Streamer;
let otherStreamer: Streamer;

async function seedEntry(
  kind: "topic" | "choice" | "binary" = "topic",
  streamId = streamer.id,
  title = "A conversation",
): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO entries (id,streamer_id,author_id,kind,title,body,category,options,created_at)
    VALUES (?,?,?,?,?,'Details','Gaming',?,?)`)
    .bind(
      id,
      streamId,
      "owner",
      kind,
      title,
      JSON.stringify(kind === "topic" ? [] : kind === "binary" ? ["Yes", "No"] : ["One", "Two"]),
      Date.now(),
    )
    .run();
  return id;
}

async function approveStreamer(userId: string): Promise<void> {
  await env.DB.prepare(`INSERT INTO streamer_applications (id,user_id,links,status,created_at,updated_at,reviewed_at)
    VALUES (?,?,'["https://example.test/channel"]','approved',1,1,1)
    ON CONFLICT(user_id) DO UPDATE SET status='approved', reviewed_at=1`)
    .bind(crypto.randomUUID(), userId)
    .run();
}

async function seedComment(entryId: string, authorId = "viewer", parentId: string | null = null): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO entry_comments (id,entry_id,author_id,text,created_at,parent_id) VALUES (?,?,?,?,?,?)",
  )
    .bind(id, entryId, authorId, "A comment", Date.now(), parentId)
    .run();
  return id;
}

beforeAll(async (): Promise<void> => {
  database = await createTestDatabase();
  env = { DB: database.db } as AppEnv;
});

afterAll(async (): Promise<void> => database.dispose());

beforeEach(async (): Promise<void> => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM user"),
    env.DB.prepare("DELETE FROM app_rate_limits"),
    ...["owner", "viewer", "other"].map(
      (id: string): D1PreparedStatement =>
        env.DB.prepare("INSERT INTO user (id,name,email,created_at,updated_at) VALUES (?,?,?,?,?)").bind(
          id,
          id,
          `${id}@example.test`,
          Date.now(),
          Date.now(),
        ),
    ),
  ]);
  await approveStreamer("owner");
  await approveStreamer("other");
  streamer = await saveStreamer(env, "owner", { handle: "misha", name: "Misha", about: "Games and tech" });
  otherStreamer = await saveStreamer(env, "other", { handle: "other", name: "Other", about: "" });
});

describe("streamer profiles", (): void => {
  it("keeps viewers private until they claim a unique public handle", async (): Promise<void> => {
    expect(await getOwnStreamer(env, "viewer")).toBeNull();
    expect((await listStreamers(env)).streamers.map((value: Streamer): string => value.handle)).toEqual([
      "misha",
      "other",
    ]);
    await env.DB.prepare("UPDATE user SET image='/images/avatar/viewer' WHERE id='viewer'").run();
    await expect(saveStreamer(env, "viewer", { handle: "viewer", name: "Viewer", about: "" })).rejects.toMatchObject({
      status: 403,
    });
    expect(await getOwnStreamer(env, "viewer")).toBeNull();
    await approveStreamer("viewer");
    const profile = await saveStreamer(env, "viewer", { handle: "viewer", name: "Viewer", about: "" });
    expect(profile.avatar).toBe("/images/avatar/viewer");
    expect(await getStreamer(env, "viewer")).toEqual(profile);
    expect(await getStreamer(env, "../private")).toBeNull();
    expect(await getStreamer(env, "missing")).toBeNull();
    await expect(saveStreamer(env, "viewer", { handle: "misha", name: "Name", about: "" })).rejects.toMatchObject({
      status: 409,
    });
    expect((await getOwnStreamer(env, "viewer"))?.id).toBe(profile.id);
  });

  it("updates one owned profile and filters provider image URLs", async (): Promise<void> => {
    const updated = await saveStreamer(env, "owner", { handle: "misha_new", name: "New name", about: "About" });
    expect(updated.id).toBe(streamer.id);
    expect(await getStreamer(env, "misha")).toBeNull();
    await env.DB.prepare("UPDATE streamers SET avatar=?,background=? WHERE id=?")
      .bind("https://provider.example/avatar", "https://evil.example/background", streamer.id)
      .run();
    expect(await getOwnStreamer(env, "owner")).toMatchObject({ avatar: null, background: null });
    await env.DB.prepare("UPDATE streamers SET avatar=?,background=? WHERE id=?")
      .bind("/images/avatar/owner", "/images/background/owner", streamer.id)
      .run();
    expect(await getOwnStreamer(env, "owner")).toMatchObject({
      avatar: "/images/avatar/owner",
      background: "/images/background/owner",
    });
  });
});

describe("topics and polls", (): void => {
  it("selects an older active overlay poll beyond the newest page and falls back after reveal", async (): Promise<void> => {
    const activeId = await seedEntry("binary");
    await env.DB.prepare("UPDATE entries SET created_at=1 WHERE id=?").bind(activeId).run();
    await mutateEntry(env, "viewer", streamer.id, { action: "vote", id: activeId, choice: 0 });
    const newerIds: string[] = Array.from({ length: 50 }, (): string => crypto.randomUUID());
    await env.DB.batch(
      newerIds.map(
        (id: string, index: number): D1PreparedStatement =>
          env.DB.prepare(`
      INSERT INTO entries(id,streamer_id,author_id,kind,title,options,created_at,revealed)
      VALUES (?,?,'owner','choice','Newer poll','["One","Two"]',?,1)
    `).bind(id, streamer.id, index + 2),
      ),
    );
    const initial = await getOverlaySnapshot(env, streamer.id, null);
    expect(initial.polls).toMatchObject([{ id: activeId, counts: null, total: 1 }]);
    expect(initial.polls).toHaveLength(1);
    expect(Object.keys(initial.polls[0]).sort()).toEqual([
      "byOwner",
      "counts",
      "endsAt",
      "id",
      "kind",
      "mash",
      "options",
      "revealed",
      "title",
      "total",
    ]);
    await mutateEntry(env, "owner", streamer.id, { action: "reveal", id: activeId });
    const next = await getOverlaySnapshot(env, streamer.id, null);
    expect(next.polls.map((poll): string => poll.id)).toEqual([newerIds[49]]);
    expect(next.revision).toBeGreaterThan(initial.revision);
    const pinned = await getOverlaySnapshot(env, streamer.id, activeId);
    expect(pinned.polls).toMatchObject([{ id: activeId, counts: [1, 0], revealed: true }]);
    expect((await getOverlaySnapshot(env, otherStreamer.id, activeId)).polls).toEqual([]);
  });

  it("skips a finished Mash Battle in automatic overlay selection, and keeps a running one", async (): Promise<void> => {
    const openId = await seedEntry("choice");
    const battleId = await seedEntry("choice");
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare("UPDATE entries SET created_at=1 WHERE id=?").bind(openId),
      env.DB.prepare("UPDATE entries SET created_at=2 WHERE id=?").bind(battleId),
      // Finished battles retain ends_at=NULL and revealed=0; read battle state.
      env.DB.prepare(
        "INSERT INTO entry_mash (entry_id,duration_s,phase,starts_at,ends_at,winner) VALUES (?,30,'finished',?,?,0)",
      ).bind(battleId, now - 60_000, now - 30_000),
    ]);
    const auto = async (): Promise<string[]> =>
      (await getOverlaySnapshot(env, streamer.id, null)).polls.map((poll): string => poll.id);
    expect(await auto()).toEqual([openId]);
    // Treat elapsed battles as finished before the persisted phase changes.
    await env.DB.prepare("UPDATE entry_mash SET phase='live' WHERE entry_id=?").bind(battleId).run();
    expect(await auto()).toEqual([openId]);
    for (const [phase, startsAt] of [
      ["live", now - 5_000],
      ["countdown", now + 3_000],
    ] as const) {
      await env.DB.prepare("UPDATE entry_mash SET phase=?, starts_at=?, ends_at=? WHERE entry_id=?")
        .bind(phase, startsAt, startsAt + 30_000, battleId)
        .run();
      expect(await auto()).toEqual([battleId]);
    }
  });

  it("excludes expired polls and topics from automatic overlay selection", async (): Promise<void> => {
    expect((await getOverlaySnapshot(env, streamer.id, null)).polls).toEqual([]);
    const unlimitedId = await seedEntry("choice");
    const expiredId = await seedEntry("choice");
    const topicId = await seedEntry();
    await env.DB.batch([
      env.DB.prepare("UPDATE entries SET created_at=1 WHERE id=?").bind(unlimitedId),
      env.DB.prepare("UPDATE entries SET created_at=2,ends_at=3 WHERE id=?").bind(expiredId),
    ]);
    expect((await getOverlaySnapshot(env, streamer.id, null)).polls.map((poll): string => poll.id)).toEqual([
      unlimitedId,
    ]);
    expect((await getOverlaySnapshot(env, streamer.id, topicId)).polls).toEqual([]);
    const newestActiveId = await seedEntry("choice");
    await env.DB.prepare("UPDATE entries SET ends_at=created_at+60000 WHERE id=?").bind(newestActiveId).run();
    expect((await getOverlaySnapshot(env, streamer.id, null)).polls.map((poll): string => poll.id)).toEqual([
      newestActiveId,
    ]);
  });

  it("persists viewer topics and polls, and polls of the owner", async (): Promise<void> => {
    const topic = await mutateEntry(env, "viewer", streamer.id, {
      action: "create",
      kind: "topic",
      title: "Useful tools",
      body: "What do you use?",
      category: "Creative",
    });
    expect(await getEntry(env, topic.id, "viewer")).toMatchObject({
      kind: "topic",
      author: "viewer",
      body: "What do you use?",
      options: [],
    });
    const viewerPoll = await mutateEntry(env, "viewer", streamer.id, {
      action: "create",
      kind: "choice",
      title: "Which one?",
      options: ["A", "B"],
    });
    expect(await getEntry(env, viewerPoll.id, null)).toMatchObject({ kind: "choice", author: "viewer", status: null });
    const poll = await mutateEntry(env, "owner", streamer.id, {
      action: "create",
      kind: "binary",
      title: "Yes or no?",
      duration: 0,
    });
    expect(await getEntry(env, poll.id, null)).toMatchObject({ endsAt: null, options: ["Yes", "No"], counts: null });
    const timed = await mutateEntry(env, "owner", streamer.id, {
      action: "create",
      kind: "choice",
      title: "Which tool?",
      options: ["A", "B"],
      duration: 60,
    });
    const timedPoll = await getEntry(env, timed.id, null);
    expect((timedPoll?.endsAt ?? 0) - (timedPoll?.createdAt ?? 0)).toBe(60000);
  });

  it("validates input before touching persistence", async (): Promise<void> => {
    for (const input of [
      { action: "create", kind: "topic", title: "Missing details" },
      { action: "create", kind: "choice", title: "Duplicate", options: ["A", "a"] },
      { action: "create", kind: "choice", title: "No options" },
      { action: "create", kind: "binary", title: "Invalid duration", duration: 1 },
      { action: "create", kind: "binary", title: "New\nline" },
      { action: "create", kind: "binary", title: "Extra property", owner: "viewer" },
    ])
      await expect(mutateEntry(env, "owner", streamer.id, input)).rejects.toMatchObject({ status: 400 });
    expect((await env.DB.prepare("SELECT count(*) AS count FROM entries").first<{ count: number }>())?.count).toBe(0);
  });

  it("keeps one vote per account under concurrent writes and changes votes", async (): Promise<void> => {
    const id = await seedEntry("choice");
    await Promise.all(
      Array.from(
        { length: 10 },
        (_value: unknown, index: number): Promise<{ id: string }> =>
          mutateEntry(env, "viewer", streamer.id, { action: "vote", id, choice: index % 2 }),
      ),
    );
    await mutateEntry(env, "viewer", streamer.id, { action: "vote", id, choice: 1 });
    const entry = await getEntry(env, id, "viewer");
    expect(entry).toMatchObject({ total: 1, counts: [0, 1], myVote: 1 });
    expect((await getEntry(env, id, null))?.myVote).toBeNull();
  });

  it("stores the server time of a new vote and of a changed vote", async (): Promise<void> => {
    const id = await seedEntry("choice");
    const votedAt = (): Promise<number | null> =>
      env.DB.prepare("SELECT voted_at FROM entry_votes WHERE entry_id=? AND user_id='viewer'")
        .bind(id)
        .first<number | null>("voted_at");
    const start: number = Date.now();
    vi.useFakeTimers({ toFake: ["Date"], now: start });
    try {
      await mutateEntry(env, "viewer", streamer.id, { action: "vote", id, choice: 0 });
      expect(await votedAt()).toBe(start);
      vi.setSystemTime(start + 60_000);
      await mutateEntry(env, "viewer", streamer.id, { action: "vote", id, choice: 1 });
      expect(await votedAt()).toBe(start + 60_000);
    } finally {
      vi.useRealTimers();
    }
    expect(await getEntry(env, id, "viewer")).toMatchObject({ total: 1, counts: [0, 1], myVote: 1 });
  });

  it("uses database time to reject expired polls and rejects invalid options", async (): Promise<void> => {
    const id = await seedEntry("choice");
    await expect(mutateEntry(env, "viewer", streamer.id, { action: "vote", id, choice: 4 })).rejects.toMatchObject({
      status: 409,
    });
    await env.DB.prepare("UPDATE entries SET created_at=1,ends_at=2 WHERE id=?").bind(id).run();
    await expect(mutateEntry(env, "viewer", streamer.id, { action: "vote", id, choice: 0 })).rejects.toMatchObject({
      status: 409,
    });
    expect((await getEntry(env, id, null))?.total).toBe(0);
    const topicId = await seedEntry();
    await expect(
      mutateEntry(env, "viewer", streamer.id, { action: "vote", id: topicId, choice: 0 }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("reveals binary results only through the owner and then closes voting", async (): Promise<void> => {
    const id = await seedEntry("binary");
    await mutateEntry(env, "viewer", streamer.id, { action: "vote", id, choice: 0 });
    await mutateEntry(env, "other", streamer.id, { action: "vote", id, choice: 1 });
    expect(await getEntry(env, id, null)).toMatchObject({ counts: null, total: 2 });
    await expect(mutateEntry(env, "viewer", streamer.id, { action: "reveal", id })).rejects.toMatchObject({
      status: 403,
    });
    await mutateEntry(env, "owner", streamer.id, { action: "reveal", id });
    expect(await getEntry(env, id, null)).toMatchObject({ counts: [1, 1], total: 2, revealed: true });
    await expect(mutateEntry(env, "viewer", streamer.id, { action: "vote", id, choice: 1 })).rejects.toMatchObject({
      status: 409,
    });
  });

  it("rejects cross-streamer entry IDs on all entry mutations", async (): Promise<void> => {
    const id = await seedEntry("choice");
    for (const input of [
      { action: "vote", id, choice: 0 },
      { action: "reveal", id },
      { action: "react", id, value: 1 },
      { action: "delete", id },
      { action: "comment", id, text: "Wrong stream" },
    ])
      await expect(mutateEntry(env, "other", otherStreamer.id, input)).rejects.toMatchObject({ status: 404 });
    expect(await getEntry(env, id, null)).toMatchObject({ total: 0, comments: 0, likes: 0, revealed: false });
  });

  it("switches reactions without double counting and orders by net score", async (): Promise<void> => {
    const first = await seedEntry();
    const second = await seedEntry();
    await mutateEntry(env, "viewer", streamer.id, { action: "react", id: first, value: 1 });
    await mutateEntry(env, "viewer", streamer.id, { action: "react", id: first, value: -1 });
    await mutateEntry(env, "other", streamer.id, { action: "react", id: second, value: 1 });
    expect(await getEntry(env, first, "viewer")).toMatchObject({ likes: 0, dislikes: 1, reaction: -1 });
    const board = await listEntries(env, streamer, "viewer", { kind: "topics", sort: "top", query: "", cursor: null });
    expect(board.entries.map((entry): string => entry.id)).toEqual([second, first]);
    await mutateEntry(env, "viewer", streamer.id, { action: "react", id: first, value: 0 });
    await mutateEntry(env, "viewer", streamer.id, { action: "react", id: first, value: 0 });
    expect(await getEntry(env, first, "viewer")).toMatchObject({ likes: 0, dislikes: 0, reaction: 0 });
  });

  it("allows the author or streamer to remove content and cascades dependent data", async (): Promise<void> => {
    const { id } = await mutateEntry(env, "viewer", streamer.id, {
      action: "create",
      kind: "topic",
      title: "Delete me",
      body: "Details",
      category: "Gaming",
    });
    await seedComment(id);
    await expect(mutateEntry(env, "other", streamer.id, { action: "delete", id })).rejects.toMatchObject({
      status: 403,
    });
    await mutateEntry(env, "owner", streamer.id, { action: "delete", id });
    expect(await getEntry(env, id, null)).toBeNull();
    expect((await listComments(env, id, null, { sort: "newest", cursor: null })).comments).toEqual([]);
    const next = await mutateEntry(env, "viewer", streamer.id, {
      action: "create",
      kind: "topic",
      title: "Mine",
      body: "Details",
      category: "Gaming",
    });
    await mutateEntry(env, "viewer", streamer.id, { action: "delete", id: next.id });
    expect(await getEntry(env, next.id, null)).toBeNull();
  });
});

describe("discussion", (): void => {
  it("enforces reply scope and keeps the thread when an authorized author removes a parent", async (): Promise<void> => {
    const id = await seedEntry();
    const foreignEntry = await seedEntry();
    const foreignParent = await seedComment(foreignEntry);
    await expect(
      mutateEntry(env, "viewer", streamer.id, { action: "comment", id, parentId: foreignParent, text: "Wrong thread" }),
    ).rejects.toMatchObject({ status: 400 });
    const parent = await mutateEntry(env, "viewer", streamer.id, { action: "comment", id, text: "Parent" });
    const reply = await mutateEntry(env, "other", streamer.id, {
      action: "comment",
      id,
      parentId: parent.id,
      text: "Reply",
    });
    await expect(mutateComment(env, "other", { action: "delete", id: parent.id })).rejects.toMatchObject({
      status: 403,
    });
    await mutateComment(env, "viewer", { action: "delete", id: parent.id });
    // Keep replies under an anonymous, empty parent placeholder.
    expect((await listComments(env, id, null, { sort: "newest", cursor: null })).comments).toMatchObject([
      { id: reply.id, parentId: parent.id, text: "Reply", removed: false },
      { id: parent.id, parentId: null, text: "", author: "", authorId: "", avatar: null, likes: 0, removed: true },
    ]);
    expect(await env.DB.prepare("SELECT text FROM entry_comments WHERE id=?").bind(parent.id).first("text")).toBe(
      "[removed]",
    );
    expect((await getEntry(env, id, null))?.comments).toBe(1);
    await expect(mutateComment(env, "viewer", { action: "delete", id: parent.id })).rejects.toMatchObject({
      status: 404,
    });
    await mutateComment(env, "owner", { action: "delete", id: reply.id });
    expect((await listComments(env, id, null, { sort: "newest", cursor: null })).comments).toEqual([]);
  });

  it("removes every placeholder above the last reply, at any depth", async (): Promise<void> => {
    const id = await seedEntry();
    const a = await seedComment(id);
    const b = await seedComment(id, "other", a);
    const c = await seedComment(id, "viewer", b);
    const kept = await seedComment(id, "other");
    const sibling = await seedComment(id, "viewer", kept);
    await mutateComment(env, "viewer", { action: "delete", id: a });
    await mutateComment(env, "other", { action: "delete", id: b });
    await mutateComment(env, "other", { action: "delete", id: kept });
    expect((await listComments(env, id, null, { sort: "newest", cursor: null })).comments).toHaveLength(5);
    await mutateComment(env, "viewer", { action: "delete", id: c });
    const left = await env.DB.prepare("SELECT id FROM entry_comments WHERE entry_id=? ORDER BY id").bind(id).all();
    expect(left.results).toEqual([{ id: kept }, { id: sibling }].sort((x, y) => x.id.localeCompare(y.id)));
  });

  it("carries the author's preset picture on topics and comments", async (): Promise<void> => {
    await env.DB.prepare("UPDATE user SET image=NULL, avatar_preset=17 WHERE id='viewer'").run();
    const topic = await mutateEntry(env, "viewer", streamer.id, {
      action: "create",
      kind: "topic",
      title: "Preset pictures",
      body: "Do they show?",
      category: "Creative",
    });
    const { id } = await mutateEntry(env, "viewer", streamer.id, { action: "comment", id: topic.id, text: "Hi" });
    await mutateEntry(env, "other", streamer.id, { action: "comment", id: topic.id, text: "Reply", parentId: id });
    expect(await getEntry(env, topic.id, null)).toMatchObject({ avatar: null, avatarPreset: 17 });
    const board = await listEntries(env, streamer, null, { kind: "topics", sort: "newest", query: "", cursor: null });
    expect(board.entries.find((entry) => entry.id === topic.id)).toMatchObject({ avatarPreset: 17 });
    expect((await listComments(env, topic.id, null, { sort: "newest", cursor: null })).comments).toMatchObject([
      { author: "other", avatarPreset: null },
      { id, author: "viewer", avatar: null, avatarPreset: 17 },
    ]);
    const threads = await listComments(env, topic.id, null, { sort: "newest", cursor: null, view: "thread" });
    expect(threads.comments).toMatchObject([
      { id, avatarPreset: 17, replies: [{ author: "other", avatarPreset: null }] },
    ]);
    await mutateComment(env, "viewer", { action: "delete", id });
    expect((await listComments(env, topic.id, null, { sort: "newest", cursor: null })).comments).toContainEqual(
      expect.objectContaining({ id, removed: true, avatarPreset: null }),
    );
  });

  it("sends a preview of each thread and pages its replies, also around a linked reply", async (): Promise<void> => {
    const id = await seedEntry();
    const root = await seedComment(id);
    const reply = (index: number): string => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
    // 120 replies, oldest first: an odd one answers the root, an even one the reply before it.
    await env.DB.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 120)
      INSERT INTO entry_comments (id,entry_id,author_id,text,created_at,parent_id)
      SELECT printf('00000000-0000-4000-8000-%012d', i), ?, 'other', 'Reply ' || i, 1000 + i,
        CASE WHEN i % 2 = 1 THEN ? ELSE printf('00000000-0000-4000-8000-%012d', i - 1) END FROM n`)
      .bind(id, root)
      .run();
    const ids = (replies: { id: string }[]): string[] => replies.map((value: { id: string }): string => value.id);
    const range = (from: number, to: number): string[] =>
      Array.from({ length: to - from + 1 }, (_: unknown, index: number): string => reply(from + index));

    const listed = await listComments(env, id, null, { sort: "newest", cursor: null, view: "thread" });
    const [thread] = listed.comments as CommentThread[];
    expect(thread).toMatchObject({ id: root, replyCount: 120, earlierReplies: 0 });
    expect(ids(thread.replies)).toEqual(range(1, 2));
    expect(thread.replies.map((value: Comment) => value.parentAuthor)).toEqual(["viewer", "other"]);

    // A place is the time and ID of a reply (created at 1000 + its number).
    const at = (direction: "after" | "before" | "from", index: number) => ({
      direction,
      createdAt: 1000 + index,
      id: reply(index),
    });
    const page = (anchor: ReturnType<typeof at> | null) => listReplies(env, root, null, anchor);
    expect(ids((await page(at("after", 2))).replies)).toEqual(range(3, 52));
    expect(await page(at("before", 60))).toMatchObject({ earlierReplies: 9 });
    expect(ids((await page(at("before", 60))).replies)).toEqual(range(10, 59));
    expect(await page(at("from", 60))).toMatchObject({ earlierReplies: 59 });
    expect(ids((await page(at("from", 60))).replies)).toEqual(range(60, 109));
    expect(await page(null)).toMatchObject({ earlierReplies: 0 });
    expect(ids((await page(null)).replies)).toEqual(range(1, 50));
    expect(await page(at("after", 120))).toEqual({ replies: [], earlierReplies: null, laterReplies: null });
    expect(await page(at("after", 2))).toMatchObject({ earlierReplies: 2, laterReplies: 68 });
    // Another reader deletes the reply a page starts from: the place still works.
    await env.DB.prepare("DELETE FROM entry_comments WHERE id=?").bind(reply(52)).run();
    expect(ids((await page(at("after", 52))).replies)).toEqual(range(53, 102));
    // The counts are those of the thread now: replies 103 to 120 follow reply 102.
    expect(await page(at("after", 52))).toMatchObject({ earlierReplies: 51, laterReplies: 18 });

    // A link to reply 60 brings the 10 replies before and after it, not the whole thread.
    const linked = await getCommentThread(env, reply(60), null);
    // Reply 52 is gone, so reply 60 is the 59th: the window holds the 59th reply and the 10 on each side.
    expect(linked.thread).toMatchObject({ id: root, replyCount: 119, earlierReplies: 48 });
    expect(ids(linked.thread.replies)).toEqual([...range(49, 51), ...range(53, 70)]);
    const linkedRoot = await getCommentThread(env, root, null);
    expect(ids(linkedRoot.thread.replies)).toEqual(range(1, 2));

    // A removed parent shows no name; only a root comment has a page of replies.
    await mutateComment(env, "other", { action: "delete", id: reply(1) });
    expect((await page(null)).replies[0]).toMatchObject({ id: reply(1), removed: true });
    expect((await page(null)).replies[1]).toMatchObject({ id: reply(2), parentAuthor: "" });
    await expect(listReplies(env, reply(3), null, null)).rejects.toMatchObject({ status: 404 });
    await expect(listReplies(env, crypto.randomUUID(), null, null)).rejects.toMatchObject({ status: 404 });
  });

  it("makes comment likes idempotent and strips provider avatar URLs", async (): Promise<void> => {
    const id = await seedEntry();
    const commentId = await seedComment(id);
    await env.DB.prepare("UPDATE user SET image=? WHERE id=?")
      .bind("https://provider.example/portrait", "viewer")
      .run();
    await mutateComment(env, "other", { action: "like", id: commentId, liked: true });
    await mutateComment(env, "other", { action: "like", id: commentId, liked: true });
    expect((await listComments(env, id, "other", { sort: "top", cursor: null })).comments).toMatchObject([
      { id: commentId, likes: 1, liked: true, avatar: null },
    ]);
    await mutateComment(env, "other", { action: "like", id: commentId, liked: false });
    expect((await listComments(env, id, "other", { sort: "top", cursor: null })).comments).toMatchObject([
      { likes: 0, liked: false },
    ]);
    await expect(
      mutateComment(env, "owner", { action: "like", id: crypto.randomUUID(), liked: true }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("paginates comments with equal timestamps without overlaps or cross-list cursor reuse", async (): Promise<void> => {
    const id = await seedEntry();
    await env.DB.batch(
      Array.from(
        { length: 101 },
        (): D1PreparedStatement =>
          env.DB.prepare("INSERT INTO entry_comments (id,entry_id,author_id,text,created_at) VALUES (?,?,?,?,?)").bind(
            crypto.randomUUID(),
            id,
            "viewer",
            "Comment",
            1,
          ),
      ),
    );
    const first = await listComments(env, id, null, { sort: "newest", cursor: null });
    const second = await listComments(env, id, null, { sort: "newest", cursor: first.nextCursor });
    expect(first.comments).toHaveLength(100);
    expect(second.comments).toHaveLength(1);
    expect(new Set([...first.comments, ...second.comments].map((comment): string => comment.id)).size).toBe(101);
    const top = await listComments(env, id, null, { sort: "top", cursor: null });
    expect((await listComments(env, id, null, { sort: "top", cursor: top.nextCursor })).comments).toHaveLength(1);
    await expect(listComments(env, id, null, { sort: "top", cursor: first.nextCursor })).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      listComments(env, crypto.randomUUID(), null, { sort: "newest", cursor: first.nextCursor }),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe("bounded reads and writes", (): void => {
  it("continues the streamer directory past fifty profiles with a validated handle cursor", async (): Promise<void> => {
    const statements: D1PreparedStatement[] = [];
    for (let index = 0; index < 55; index++) {
      const id = crypto.randomUUID();
      const handle = `streamer_${String(index).padStart(2, "0")}`;
      statements.push(
        env.DB.prepare("INSERT INTO user(id,name,email,created_at,updated_at) VALUES (?,?,?,1,1)").bind(
          id,
          handle,
          `${handle}@example.test`,
        ),
        env.DB.prepare("INSERT INTO streamers(id,owner_id,handle,name) VALUES (?,?,?,?)").bind(
          crypto.randomUUID(),
          id,
          handle,
          handle,
        ),
      );
    }
    await env.DB.batch(statements);
    const first = await listStreamers(env);
    expect(first.streamers).toHaveLength(50);
    expect(first.nextCursor).toBe("streamer_47");
    const next = await listStreamers(env, first.nextCursor);
    expect(next.streamers).toHaveLength(7);
    expect(next.nextCursor).toBeNull();
    const handles = [...first.streamers, ...next.streamers].map((value: Streamer): string => value.handle);
    expect(new Set(handles).size).toBe(57);
    expect(handles).toEqual([...handles].sort());
    expect(await listStreamers(env, "zzzzzz")).toEqual({ streamers: [], nextCursor: null });
    for (const cursor of ["", "../misha", "MiSha", "x".repeat(31)]) {
      await expect(listStreamers(env, cursor)).rejects.toMatchObject({ status: 400 });
    }
  });

  it("rejects new content when a streamer or discussion reaches its capacity", async (): Promise<void> => {
    await env.DB.prepare(`WITH RECURSIVE sequence(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM sequence WHERE n<1000)
      INSERT INTO entries(id,streamer_id,author_id,kind,title,created_at)
      SELECT printf('00000000-0000-4000-8000-%012d',n),?,'owner','topic','Topic',1 FROM sequence`)
      .bind(streamer.id)
      .run();
    await expect(
      mutateEntry(env, "viewer", streamer.id, {
        action: "create",
        kind: "topic",
        title: "Overflow",
        body: "Details",
        category: "Gaming",
      }),
    ).rejects.toMatchObject({ status: 403 });
    const id = "00000000-0000-4000-8000-000000000001";
    await env.DB.prepare(`WITH RECURSIVE sequence(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM sequence WHERE n<10000)
      INSERT INTO entry_comments(id,entry_id,author_id,text,created_at)
      SELECT printf('10000000-0000-4000-8000-%012d',n),?,'viewer','Comment',1 FROM sequence`)
      .bind(id)
      .run();
    await expect(
      mutateEntry(env, "viewer", streamer.id, { action: "comment", id, text: "Overflow" }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("paginates Unicode searches and treats SQL wildcard characters as literal text", async (): Promise<void> => {
    await env.DB.batch(
      Array.from(
        { length: 51 },
        (): D1PreparedStatement =>
          env.DB.prepare(
            "INSERT INTO entries (id,streamer_id,author_id,kind,title,options,created_at) VALUES (?,?,?,'topic',?,'[]',1)",
          ).bind(crypto.randomUUID(), streamer.id, "owner", "кофе 😀a 100%"),
      ),
    );
    await seedEntry("topic", streamer.id, "other");
    const first = await listEntries(env, streamer, null, {
      kind: "topics",
      sort: "newest",
      query: "кофе",
      cursor: null,
    });
    const next = await listEntries(env, streamer, null, {
      kind: "topics",
      sort: "newest",
      query: "кофе",
      cursor: first.nextCursor,
    });
    for (const query of ["кофе", "кофе 😀", "кофе 😀a 100"]) {
      const page = await listEntries(env, streamer, null, {
        kind: "topics",
        sort: "newest",
        query,
        cursor: null,
      });
      const last = page.entries.at(-1)!;
      const legacyCursor = Buffer.from(
        JSON.stringify({
          scope: `${streamer.id}:topics`,
          sort: "newest",
          query,
          score: 0,
          time: last.createdAt,
          id: last.id,
        }),
        "utf8",
      ).toString("base64url");
      expect(page.nextCursor).toBe(legacyCursor);
      expect(page.nextCursor).not.toMatch(/[=+/]/u);
      const continuation = await listEntries(env, streamer, null, {
        kind: "topics",
        sort: "newest",
        query,
        cursor: legacyCursor,
      });
      expect(continuation.entries).toHaveLength(1);
    }
    expect(first.entries).toHaveLength(50);
    expect(next.entries).toHaveLength(1);
    expect(new Set([...first.entries, ...next.entries].map((entry): string => entry.id)).size).toBe(51);
    const top = await listEntries(env, streamer, null, { kind: "topics", sort: "top", query: "кофе", cursor: null });
    expect(
      (await listEntries(env, streamer, null, { kind: "topics", sort: "top", query: "кофе", cursor: top.nextCursor }))
        .entries,
    ).toHaveLength(1);
    expect(
      (await listEntries(env, streamer, null, { kind: "topics", sort: "newest", query: "%", cursor: null })).entries,
    ).toHaveLength(50);
    await expect(
      listEntries(env, streamer, null, { kind: "polls", sort: "newest", query: "кофе", cursor: first.nextCursor }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      listEntries(env, streamer, null, { kind: "topics", sort: "newest", query: "", cursor: "invalid" }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("shares mutation quotas across targets and rejects concurrent excess writes atomically", async (): Promise<void> => {
    await startOfQuotaWindow(env.DB);
    await env.DB.prepare(
      "INSERT INTO app_rate_limits (key,count,window_start) VALUES ('write:viewer',59,CAST(strftime('%s','now') AS INTEGER)/60*60000)",
    ).run();
    const first = await seedEntry();
    const second = await seedEntry("topic", otherStreamer.id);
    await mutateEntry(env, "viewer", streamer.id, { action: "react", id: first, value: 1 });
    await expect(
      mutateEntry(env, "viewer", otherStreamer.id, { action: "react", id: second, value: 1 }),
    ).rejects.toMatchObject({ status: 429 });
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (): Promise<void> => consumeMutationQuota(env, "other", true)),
    );
    expect(results.filter((result: PromiseSettledResult<void>): boolean => result.status === "fulfilled")).toHaveLength(
      6,
    );
    await env.DB.prepare("UPDATE app_rate_limits SET window_start=0 WHERE key='content:other'").run();
    await expect(consumeMutationQuota(env, "other", true)).resolves.toBeUndefined();
  });

  it("increments a durable board revision with committed changes", async (): Promise<void> => {
    const id = await seedEntry();
    const before = await listEntries(env, streamer, null, { kind: "topics", sort: "newest", query: "", cursor: null });
    await mutateEntry(env, "viewer", streamer.id, { action: "react", id, value: 1 });
    const after = await listEntries(env, streamer, null, { kind: "topics", sort: "newest", query: "", cursor: null });
    expect(after.revision).toBeGreaterThan(before.revision);
    expect(after.entries[0].likes).toBe(1);
  });
});
