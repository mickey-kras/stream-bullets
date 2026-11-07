import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../app/env";
import type { ContentReport, ReportStatus, Streamer } from "../app/types";
import { deleteComment, listComments, mutateComment } from "../app/server/comments.server";
import { deleteEntry, mutateEntry, saveStreamer } from "../app/server/data.server";
import { listReports, resolveReport, submitReport } from "../app/server/reports.server";
import type { ReportInput } from "../app/server/validation";
import { createTestDatabase } from "./helpers/database";
import type { TestDatabase } from "./helpers/database";

let database: TestDatabase;
let env: AppEnv;
let streamer: Streamer;

async function seedUser(id: string, verified = true): Promise<void> {
  await env.DB.prepare("INSERT INTO user (id,name,email,email_verified,created_at,updated_at) VALUES (?,?,?,?,1,1)")
    .bind(id, `Name ${id}`, `${id}@example.test`, verified ? 1 : 0)
    .run();
}

async function seedEntry(
  kind: "topic" | "choice" = "topic",
  authorId = "author",
  title = "Reported topic",
): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO entries (id,streamer_id,author_id,kind,title,body,category,options,created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .bind(
      id,
      streamer.id,
      authorId,
      kind,
      title,
      kind === "topic" ? "Topic details" : "",
      kind === "topic" ? "Gaming" : "",
      JSON.stringify(kind === "topic" ? [] : ["Red", "Blue"]),
      Date.now(),
    )
    .run();
  return id;
}

async function seedComment(entryId: string, authorId = "author", parentId: string | null = null): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO entry_comments (id,entry_id,author_id,text,created_at,parent_id) VALUES (?,?,?,?,?,?)",
  )
    .bind(id, entryId, authorId, `Comment by ${authorId}`, Date.now(), parentId)
    .run();
  return id;
}

function report(reporterId: string, input: Partial<ReportInput>): ReturnType<typeof submitReport> {
  return submitReport(env, reporterId, { reason: "spam", ...input } as ReportInput);
}

async function revision(): Promise<number> {
  return (await env.DB.prepare("SELECT revision FROM streamers WHERE id=?")
    .bind(streamer.id)
    .first<number>("revision")) as number;
}

async function statuses(targetId: string): Promise<ReportStatus[]> {
  const { results } = await env.DB.prepare("SELECT status FROM content_reports WHERE target_id=? ORDER BY status")
    .bind(targetId)
    .all<{ status: ReportStatus }>();
  return results.map((row: { status: ReportStatus }): ReportStatus => row.status);
}

beforeAll(async (): Promise<void> => {
  database = await createTestDatabase();
  env = { DB: database.db, ADMIN_EMAILS: "admin@example.test, unverified@example.test" } as AppEnv;
});

afterAll(async (): Promise<void> => database.dispose());

beforeEach(async (): Promise<void> => {
  vi.restoreAllMocks();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM content_reports"),
    env.DB.prepare("DELETE FROM user"),
    env.DB.prepare("DELETE FROM app_rate_limits"),
  ]);
  for (const id of ["owner", "author", "reporter", "second", "admin"]) await seedUser(id);
  await seedUser("unverified", false);
  await env.DB.prepare(`INSERT INTO streamer_applications (id,user_id,links,status,created_at,updated_at,reviewed_at)
    VALUES (?, 'owner', '["https://example.test/channel"]', 'approved', 1, 1, 1)`)
    .bind(crypto.randomUUID())
    .run();
  streamer = await saveStreamer(env, "owner", { handle: "reported", name: "Reported", about: "" });
});

describe("submitting reports", (): void => {
  it("stores a snapshot of a topic, a poll, and a comment", async (): Promise<void> => {
    const topic = await seedEntry();
    const poll = await seedEntry("choice", "owner", "Pick a colour");
    const comment = await seedComment(topic);
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    const first = await report("reporter", {
      targetKind: "entry",
      targetId: topic,
      reason: "illegal",
      details: "  Breaks the law.  ",
    });
    expect(first).toMatchObject({ createdAt: 1_000 });
    await report("reporter", { targetKind: "entry", targetId: poll, reason: "harassment" });
    await report("reporter", { targetKind: "comment", targetId: comment, reason: "privacy" });
    const queue = await listReports(env, "admin", {});
    expect(queue.nextCursor).toBeNull();
    const byTarget = new Map(queue.reports.map((item: ContentReport) => [item.targetId, item]));
    expect(byTarget.get(topic)).toMatchObject({
      id: first.id,
      targetKind: "entry",
      reason: "illegal",
      details: "Breaks the law.",
      snapshot: "Reported topic\n\nTopic details",
      status: "open",
      resolvedAt: null,
      reporterName: "Name reporter",
      streamerHandle: "reported",
      entryId: topic,
    });
    expect(byTarget.get(poll)).toMatchObject({ snapshot: "Pick a colour\n\nOptions: Red · Blue", details: "" });
    expect(byTarget.get(comment)).toMatchObject({
      targetKind: "comment",
      snapshot: "Comment by author",
      entryId: topic,
    });
    // The content author is stored so account deletion can find the report after the content is gone.
    const authors = await env.DB.prepare(
      "SELECT target_id,target_author_id FROM content_reports ORDER BY target_id",
    ).all<{ target_id: string; target_author_id: string }>();
    expect(Object.fromEntries(authors.results.map((row) => [row.target_id, row.target_author_id]))).toEqual({
      [topic]: "author",
      [poll]: "owner",
      [comment]: "author",
    });
  });

  it("keeps one open report per reporter and target", async (): Promise<void> => {
    const topic = await seedEntry();
    const first = await report("reporter", { targetKind: "entry", targetId: topic });
    const updated = await report("reporter", {
      targetKind: "entry",
      targetId: topic,
      reason: "other",
      details: "More context",
    });
    expect(updated.id).toBe(first.id);
    await report("second", { targetKind: "entry", targetId: topic });
    const queue = await listReports(env, "admin", { status: "open" });
    expect(queue.reports).toHaveLength(2);
    expect(queue.reports.find((item: ContentReport) => item.id === first.id)).toMatchObject({
      reason: "other",
      details: "More context",
    });
    await resolveReport(env, "admin", { id: first.id, action: "dismiss" });
    const again = await report("reporter", { targetKind: "entry", targetId: topic });
    expect(again.id).not.toBe(first.id);
  });

  it("clips long snapshots to the stored limit", async (): Promise<void> => {
    const topic = await seedEntry();
    await env.DB.prepare("UPDATE entries SET body=? WHERE id=?").bind("😀".repeat(2000), topic).run();
    await report("reporter", { targetKind: "entry", targetId: topic });
    const [item] = (await listReports(env, "admin", {})).reports;
    expect(Array.from(item.snapshot)).toHaveLength(2000);
    expect(item.snapshot.endsWith("😀…")).toBe(true);
  });

  it("rejects invalid, missing, and own content", async (): Promise<void> => {
    const topic = await seedEntry();
    await expect(report("reporter", { targetKind: "entry", targetId: "not-a-uuid" })).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      report("reporter", { targetKind: "entry", targetId: topic, reason: "fake" as "spam" }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      report("reporter", { targetKind: "entry", targetId: topic, details: "x".repeat(1001) }),
    ).rejects.toMatchObject({ status: 400, message: "Keep the details under 1000 characters." });
    for (const reason of ["illegal", "other"] as const) {
      await expect(
        report("reporter", { targetKind: "entry", targetId: topic, reason, details: "   " }),
      ).rejects.toMatchObject({
        status: 400,
        message: "Explain why this content breaks the law or the community rules.",
      });
    }
    await expect(report("reporter", { targetKind: "entry", targetId: crypto.randomUUID() })).rejects.toMatchObject({
      status: 404,
      message: "Topic or poll not found.",
    });
    await expect(report("reporter", { targetKind: "comment", targetId: crypto.randomUUID() })).rejects.toMatchObject({
      status: 404,
      message: "Comment not found.",
    });
    await expect(report("author", { targetKind: "entry", targetId: topic })).rejects.toMatchObject({
      status: 400,
      message: "You can't report your own content.",
    });
    expect((await listReports(env, "admin", {})).reports).toHaveLength(0);
  });

  it("limits how often an account can report", async (): Promise<void> => {
    const topics = await Promise.all(Array.from({ length: 7 }, () => seedEntry()));
    for (const topic of topics.slice(0, 6)) await report("reporter", { targetKind: "entry", targetId: topic });
    await expect(report("reporter", { targetKind: "entry", targetId: topics[6] })).rejects.toMatchObject({
      status: 429,
    });
  });

  it("keeps reports after the reporter, the content, and the streamer page are deleted", async (): Promise<void> => {
    const topic = await seedEntry();
    await report("reporter", { targetKind: "entry", targetId: topic });
    await env.DB.prepare("DELETE FROM user WHERE id='reporter'").run();
    let [item] = (await listReports(env, "admin", {})).reports;
    expect(item).toMatchObject({ reporterName: null, entryId: topic, streamerHandle: "reported" });
    await env.DB.prepare("DELETE FROM entries WHERE id=?").bind(topic).run();
    [item] = (await listReports(env, "admin", {})).reports;
    expect(item).toMatchObject({ entryId: null, snapshot: "Reported topic\n\nTopic details" });
    await env.DB.prepare("DELETE FROM user WHERE id='owner'").run();
    [item] = (await listReports(env, "admin", {})).reports;
    expect(item).toMatchObject({ streamerHandle: null, entryId: null });
  });
});

describe("reviewing reports", (): void => {
  it("is limited to verified administrators", async (): Promise<void> => {
    const topic = await seedEntry();
    const { id } = await report("reporter", { targetKind: "entry", targetId: topic });
    for (const user of ["reporter", "owner", "unverified"]) {
      await expect(listReports(env, user, {})).rejects.toMatchObject({ status: 403 });
      await expect(resolveReport(env, user, { id, action: "remove" })).rejects.toMatchObject({ status: 403 });
    }
    expect(await statuses(topic)).toEqual(["open"]);
  });

  it("pages through each status queue in a stable order", async (): Promise<void> => {
    // Insert the queue with one set-based statement. Hundreds of separate prepare() calls each need a
    // synchronous Miniflare proxy round-trip, which can fall out of step on slow CI runners.
    const topic = await seedEntry();
    const rows = Array.from({ length: 120 }, () => crypto.randomUUID());
    await env.DB.prepare(`INSERT INTO content_reports
      (id,target_kind,target_id,streamer_id,reporter_id,reason,snapshot,status,created_at,resolved_at)
      SELECT value, 'entry', ?, ?, NULL, 'spam', 'Snapshot', 'dismissed', 5, 6 FROM json_each(?)`)
      .bind(topic, streamer.id, JSON.stringify(rows))
      .run();
    const seen: string[] = [];
    const sizes: number[] = [];
    let cursor: string | null = null;
    do {
      const page = await listReports(env, "admin", { status: "dismissed", cursor });
      sizes.push(page.reports.length);
      seen.push(...page.reports.map((item: ContentReport): string => item.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(sizes).toEqual([50, 50, 20]);
    expect(seen).toEqual([...rows].sort().reverse());
    expect((await listReports(env, "admin", { status: "open" })).reports).toHaveLength(0);
    await expect(listReports(env, "admin", { cursor: "bad" })).rejects.toMatchObject({ status: 400 });
    await expect(listReports(env, "admin", { status: "closed" as "open" })).rejects.toMatchObject({ status: 400 });
  });

  it("dismisses every open report about the same content", async (): Promise<void> => {
    const topic = await seedEntry();
    const other = await seedEntry();
    const { id } = await report("reporter", { targetKind: "entry", targetId: topic });
    await report("second", { targetKind: "entry", targetId: topic });
    await report("second", { targetKind: "entry", targetId: other });
    const before = await revision();
    vi.spyOn(Date, "now").mockReturnValue(9_000);
    expect(await resolveReport(env, "admin", { id, action: "dismiss" })).toEqual({
      status: "dismissed",
      resolved: 2,
      streamerId: null,
    });
    expect(await revision()).toBe(before);
    expect(await statuses(topic)).toEqual(["dismissed", "dismissed"]);
    expect(await statuses(other)).toEqual(["open"]);
    const [resolved] = (await listReports(env, "admin", { status: "dismissed" })).reports;
    expect(resolved).toMatchObject({ resolvedAt: 9_000, entryId: topic });
    const row = await env.DB.prepare("SELECT resolved_by FROM content_reports WHERE id=?").bind(id).first();
    expect(row).toEqual({ resolved_by: "admin" });
    await expect(resolveReport(env, "admin", { id, action: "remove" })).rejects.toMatchObject({ status: 409 });
    await expect(resolveReport(env, "admin", { id: crypto.randomUUID(), action: "dismiss" })).rejects.toMatchObject({
      status: 404,
    });
    await expect(resolveReport(env, "admin", { id, action: "ban" as "remove" })).rejects.toMatchObject({
      status: 400,
    });
  });

  it("removes a reported topic and marks its reports actioned", async (): Promise<void> => {
    const topic = await seedEntry();
    const { id } = await report("reporter", { targetKind: "entry", targetId: topic });
    await report("second", { targetKind: "entry", targetId: topic });
    const before = await revision();
    expect(await resolveReport(env, "admin", { id, action: "remove" })).toEqual({
      status: "actioned",
      resolved: 2,
      streamerId: streamer.id,
    });
    expect(await revision()).toBe(before + 1);
    expect(await env.DB.prepare("SELECT id FROM entries WHERE id=?").bind(topic).first()).toBeNull();
    expect(await statuses(topic)).toEqual(["actioned", "actioned"]);
    const [item] = (await listReports(env, "admin", { status: "actioned" })).reports;
    expect(item).toMatchObject({ entryId: null, snapshot: "Reported topic\n\nTopic details" });
  });

  it("removes a reported comment and keeps its replies under a placeholder", async (): Promise<void> => {
    const topic = await seedEntry();
    const parent = await seedComment(topic);
    const reply = await seedComment(topic, "second", parent);
    const { id } = await report("reporter", { targetKind: "comment", targetId: parent, reason: "harassment" });
    const before = await revision();
    expect(await resolveReport(env, "admin", { id, action: "remove" })).toMatchObject({
      status: "actioned",
      streamerId: streamer.id,
    });
    expect(await revision()).toBe(before + 1);
    const { comments } = await listComments(env, topic, null, { sort: "newest", cursor: null });
    expect(comments.map((comment) => [comment.id, comment.parentId, comment.removed])).toEqual([
      [reply, parent, false],
      [parent, null, true],
    ]);
    // A placeholder cannot be reported again.
    await expect(report("reporter", { targetKind: "comment", targetId: parent, reason: "spam" })).rejects.toMatchObject(
      { status: 404 },
    );
  });

  it("closes the report when the content is already gone", async (): Promise<void> => {
    const topic = await seedEntry();
    const comment = await seedComment(topic);
    const entryReport = await report("reporter", { targetKind: "entry", targetId: topic });
    const commentReport = await report("reporter", { targetKind: "comment", targetId: comment });
    await mutateEntry(env, "author", streamer.id, { action: "delete", id: topic });
    expect(await resolveReport(env, "admin", { id: entryReport.id, action: "remove" })).toEqual({
      status: "actioned",
      resolved: 1,
      streamerId: null,
    });
    expect(await resolveReport(env, "admin", { id: commentReport.id, action: "remove" })).toEqual({
      status: "actioned",
      resolved: 1,
      streamerId: null,
    });
  });

  it("surfaces unexpected removal failures and leaves the report open", async (): Promise<void> => {
    const topic = await seedEntry();
    const { id } = await report("reporter", { targetKind: "entry", targetId: topic });
    const failing = {
      ...env,
      DB: new Proxy(env.DB, {
        get(target: D1Database, key: string | symbol): unknown {
          if (key === "batch") return (): Promise<never> => Promise.reject(new Error("D1 unavailable"));
          const value: unknown = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }),
    } as AppEnv;
    await expect(resolveReport(failing, "admin", { id, action: "remove" })).rejects.toThrow("D1 unavailable");
    expect(await statuses(topic)).toEqual(["open"]);
  });
});

describe("moderation rights", (): void => {
  it("lets administrators delete any topic, poll, or comment", async (): Promise<void> => {
    const topic = await seedEntry();
    const poll = await seedEntry("choice", "owner");
    const parent = await seedComment(topic);
    const reply = await seedComment(topic, "second", parent);
    await mutateComment(env, "admin", { action: "delete", id: parent });
    const { comments } = await listComments(env, topic, null, { sort: "newest", cursor: null });
    expect(comments.map((comment) => [comment.id, comment.parentId, comment.removed])).toEqual([
      [reply, parent, false],
      [parent, null, true],
    ]);
    expect(await deleteComment(env, "admin", reply)).toEqual({ streamerId: streamer.id });
    expect(await env.DB.prepare("SELECT count(*) AS n FROM entry_comments").first("n")).toBe(0);
    await mutateEntry(env, "admin", streamer.id, { action: "delete", id: poll });
    await deleteEntry(env, "admin", streamer.id, topic);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM entries").first("n")).toBe(0);
  });

  it("keeps regular users limited to their own content and their own page", async (): Promise<void> => {
    const topic = await seedEntry();
    const comment = await seedComment(topic);
    for (const user of ["reporter", "unverified"]) {
      await expect(mutateEntry(env, user, streamer.id, { action: "delete", id: topic })).rejects.toMatchObject({
        status: 403,
        message: "Only the author or streamer can remove this item.",
      });
      await expect(deleteEntry(env, user, streamer.id, topic)).rejects.toMatchObject({ status: 403 });
      await expect(mutateComment(env, user, { action: "delete", id: comment })).rejects.toMatchObject({
        status: 403,
        message: "Only the author or streamer can remove this comment.",
      });
      await expect(deleteComment(env, user, comment)).rejects.toMatchObject({ status: 403 });
    }
    await expect(
      mutateEntry({ ...env, ADMIN_EMAILS: undefined }, "admin", streamer.id, { action: "delete", id: topic }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(deleteComment(env, "admin", crypto.randomUUID())).rejects.toMatchObject({ status: 404 });
    await mutateComment(env, "owner", { action: "delete", id: comment });
    await deleteEntry(env, "author", streamer.id, topic);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM entries").first("n")).toBe(0);
  });
});
