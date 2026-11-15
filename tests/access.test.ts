import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../app/env";
import type { ApplicationReviewItem, StreamerStatus } from "../app/types";
import {
  adminEmails,
  assertStreamerWritable,
  canCreateStreamer,
  canViewStreamer,
  getApplication,
  getStreamerAccess,
  isAdmin,
  isStreamerListed,
  isStreamerVisible,
  isStreamerWritable,
  listApplications,
  requireAdmin,
  reviewApplication,
  submitApplication,
} from "../app/server/access.server";
import {
  getOverlaySnapshot,
  getOwnStreamer,
  getVisibleEntry,
  getVisibleStreamer,
  listStreamers,
  mutateEntry,
  saveStreamer,
  updateStreamer,
} from "../app/server/data.server";
import { mutateComment } from "../app/server/comments.server";
import type { ApplicationInput } from "../app/server/validation";
import { createTestDatabase } from "./helpers/database";
import type { TestDatabase } from "./helpers/database";

const ADMIN_EMAILS = "Admin@Example.test, unverified@example.test";
const link = "https://www.twitch.tv/applicant";

let database: TestDatabase;
let env: AppEnv;

function withAdmins(value: string | undefined): AppEnv {
  return { ...env, ADMIN_EMAILS: value };
}

async function seedUser(id: string, verified = true, email = `${id}@example.test`): Promise<void> {
  await env.DB.prepare("INSERT INTO user (id,name,email,email_verified,created_at,updated_at) VALUES (?,?,?,?,1,1)")
    .bind(id, `Name ${id}`, email, verified ? 1 : 0)
    .run();
}

async function seedApplication(
  userId: string,
  status: "pending" | "approved" | "rejected",
  updatedAt: number,
  id: string = crypto.randomUUID(),
): Promise<string> {
  await env.DB.prepare(`INSERT INTO streamer_applications (id,user_id,links,status,created_at,updated_at,reviewed_at)
    VALUES (?,?,?,?,?,?,?)`)
    .bind(id, userId, JSON.stringify([link]), status, updatedAt, updatedAt, status === "pending" ? null : updatedAt)
    .run();
  return id;
}

function submit(userId: string, input: Partial<ApplicationInput>): ReturnType<typeof submitApplication> {
  return submitApplication(env, userId, input as ApplicationInput);
}

beforeAll(async (): Promise<void> => {
  database = await createTestDatabase();
  env = { DB: database.db, ADMIN_EMAILS } as AppEnv;
});

afterAll(async (): Promise<void> => database.dispose());

beforeEach(async (): Promise<void> => {
  vi.restoreAllMocks();
  await env.DB.batch([env.DB.prepare("DELETE FROM user"), env.DB.prepare("DELETE FROM app_rate_limits")]);
  await seedUser("admin", true, "admin@example.test");
  await seedUser("unverified", false);
  await seedUser("applicant");
  await seedUser("viewer");
});

describe("administrators", (): void => {
  it("parses the operator list with mixed separators and any case", (): void => {
    expect(adminEmails(withAdmins(undefined)).size).toBe(0);
    expect(adminEmails(withAdmins("")).size).toBe(0);
    expect(adminEmails(withAdmins(" , \n\t")).size).toBe(0);
    expect([...adminEmails(withAdmins(" A@x.test,b@X.TEST\n c@x.test\t,, not-an-email d@x.test "))]).toEqual([
      "a@x.test",
      "b@x.test",
      "c@x.test",
      "d@x.test",
    ]);
  });

  it("requires a listed and verified email address", async (): Promise<void> => {
    expect(await isAdmin(env, "admin")).toBe(true);
    expect(await isAdmin(env, "unverified")).toBe(false);
    expect(await isAdmin(env, "viewer")).toBe(false);
    expect(await isAdmin(env, "missing")).toBe(false);
    expect(await isAdmin(withAdmins(undefined), "admin")).toBe(false);
    expect(await isAdmin(withAdmins("ADMIN@EXAMPLE.TEST"), "admin")).toBe(true);
    await env.DB.prepare("UPDATE user SET email='ADMIN@example.TEST' WHERE id='admin'").run();
    expect(await isAdmin(withAdmins("admin@example.test"), "admin")).toBe(true);
    await expect(requireAdmin(env, "admin")).resolves.toBeUndefined();
    await expect(requireAdmin(env, "unverified")).rejects.toMatchObject({ status: 403 });
  });
});

describe("streamer applications", (): void => {
  it("creates and updates a pending application", async (): Promise<void> => {
    expect(await getApplication(env, "applicant")).toBeNull();
    const created = await submit("applicant", { links: [`  ${link}  `] });
    expect(created).toMatchObject({ links: [link], note: "", status: "pending", reviewedAt: null });
    expect(created.createdAt).toBe(created.updatedAt);
    vi.spyOn(Date, "now").mockReturnValue(created.createdAt + 1000);
    const updated = await submit("applicant", {
      links: [link, "https://youtube.com/@applicant"],
      note: "  Line one\nLine two\ttab  ",
    });
    expect(updated).toMatchObject({
      id: created.id,
      links: [link, "https://youtube.com/@applicant"],
      note: "Line one\nLine two\ttab",
      status: "pending",
      createdAt: created.createdAt,
      updatedAt: created.createdAt + 1000,
    });
    expect(await getApplication(env, "applicant")).toEqual(updated);
  });

  it("returns a rejected application to the queue and clears the review", async (): Promise<void> => {
    const created = await submit("applicant", { links: [link] });
    const rejected = await reviewApplication(env, "admin", { id: created.id, decision: "rejected" });
    expect(rejected.status).toBe("rejected");
    expect(rejected.reviewedAt).toEqual(expect.any(Number));
    const resubmitted = await submit("applicant", { links: [link], note: "Try again" });
    expect(resubmitted).toMatchObject({ id: created.id, status: "pending", reviewedAt: null, note: "Try again" });
    const row = await env.DB.prepare("SELECT reviewed_by FROM streamer_applications WHERE id=?")
      .bind(created.id)
      .first<{ reviewed_by: string | null }>();
    expect(row?.reviewed_by).toBeNull();
  });

  it("refuses changes after approval or once the user owns a streamer", async (): Promise<void> => {
    const created = await submit("applicant", { links: [link] });
    await reviewApplication(env, "admin", { id: created.id, decision: "approved" });
    await expect(submit("applicant", { links: [link], note: "Changed" })).rejects.toMatchObject({ status: 409 });
    expect(await getApplication(env, "applicant")).toMatchObject({ status: "approved", note: "" });

    await env.DB.prepare("INSERT INTO streamers (id,owner_id,handle,name) VALUES (?,?,?,?)")
      .bind(crypto.randomUUID(), "viewer", "viewer", "Viewer")
      .run();
    await expect(submit("viewer", { links: [link] })).rejects.toMatchObject({ status: 409 });
    expect(await getApplication(env, "viewer")).toBeNull();
  });

  it.each([
    ["non-HTTPS links", { links: ["http://twitch.tv/applicant"] }],
    ["non-web links", { links: ["javascript:alert(1)"] }],
    ["malformed links", { links: ["not a url"] }],
    ["credentials in links", { links: ["https://user:pass@twitch.tv/applicant"] }],
    ["usernames in links", { links: ["https://user@twitch.tv/applicant"] }],
    ["long links", { links: [`https://twitch.tv/${"a".repeat(200)}`] }],
    ["no links", { links: [] }],
    ["missing links", {}],
    ["more than five links", { links: Array.from({ length: 6 }, (_: unknown, index: number) => `${link}${index}`) }],
    ["duplicate links in any case", { links: [link, link.toUpperCase().replace("HTTPS", "https")] }],
    ["long notes", { links: [link], note: "a".repeat(1001) }],
    ["control characters in notes", { links: [link], note: "Hello\u0000there" }],
    ["unknown fields", { links: [link], status: "approved" }],
  ])("rejects %s", async (_: string, input: Record<string, unknown>): Promise<void> => {
    await expect(submit("applicant", input as Partial<ApplicationInput>)).rejects.toMatchObject({ status: 400 });
    expect(await getApplication(env, "applicant")).toBeNull();
  });

  it("accepts the documented limits", async (): Promise<void> => {
    const links = Array.from({ length: 5 }, (_: unknown, index: number): string => `${link}${index}`);
    const value = await submit("applicant", { links, note: "a".repeat(1000) });
    expect(value.links).toEqual(links);
    expect(value.note).toHaveLength(1000);
  });
});

describe("review queue", (): void => {
  it("filters by status and orders pending oldest first and reviewed newest first", async (): Promise<void> => {
    for (const id of ["p1", "p2", "a1", "a2", "r1"]) await seedUser(id);
    const p2 = await seedApplication("p2", "pending", 20);
    const p1 = await seedApplication("p1", "pending", 10);
    const a1 = await seedApplication("a1", "approved", 10);
    const a2 = await seedApplication("a2", "approved", 20);
    const r1 = await seedApplication("r1", "rejected", 30);

    const ids = (items: ApplicationReviewItem[]): string[] => items.map((item: ApplicationReviewItem) => item.id);
    const pending = await listApplications(env, { status: "pending", cursor: null });
    expect(ids(pending.applications)).toEqual([p1, p2]);
    expect(pending.nextCursor).toBeNull();
    expect(pending.applications[0]).toEqual({
      id: p1,
      userId: "p1",
      name: "Name p1",
      email: "p1@example.test",
      links: [link],
      note: "",
      status: "pending",
      createdAt: 10,
      updatedAt: 10,
      reviewedAt: null,
    });
    expect(ids((await listApplications(env, { status: "approved", cursor: null })).applications)).toEqual([a2, a1]);
    expect(ids((await listApplications(env, { status: "rejected", cursor: null })).applications)).toEqual([r1]);
    expect(ids((await listApplications(env, {} as never)).applications)).toEqual([p1, p2]);
  });

  it.each(["pending", "rejected"] as const)(
    "pages %s applications with equal timestamps without overlap",
    async (status: "pending" | "rejected"): Promise<void> => {
      // Batch the seed to avoid slow, synchronous Miniflare proxy calls.
      const rows = Array.from({ length: 120 }, (_: unknown, index: number) => ({
        user: `queue_${index}`,
        id: crypto.randomUUID(),
      }));
      const expected: string[] = rows.map((row: { id: string }): string => row.id);
      const seed = JSON.stringify(rows);
      await env.DB.batch([
        env.DB.prepare(`INSERT INTO user (id,name,email,created_at,updated_at)
          SELECT value->>'user', value->>'user', (value->>'user') || '@example.test', 1, 1 FROM json_each(?)`).bind(
          seed,
        ),
        env.DB.prepare(`INSERT INTO streamer_applications (id,user_id,links,status,created_at,updated_at,reviewed_at)
          SELECT value->>'id', value->>'user', ?, ?, 5, 5, ? FROM json_each(?)`).bind(
          JSON.stringify([link]),
          status,
          status === "pending" ? null : 5,
          seed,
        ),
      ]);
      const seen: string[] = [];
      let cursor: string | null = null;
      const sizes: number[] = [];
      do {
        const page = await listApplications(env, { status, cursor });
        sizes.push(page.applications.length);
        seen.push(...page.applications.map((item: ApplicationReviewItem): string => item.id));
        cursor = page.nextCursor;
      } while (cursor);
      expect(sizes).toEqual([50, 50, 20]);
      expect(new Set(seen).size).toBe(120);
      expect(seen).toEqual(status === "pending" ? [...expected].sort() : [...expected].sort().reverse());
    },
  );

  it("rejects invalid cursors and filters", async (): Promise<void> => {
    for (const cursor of ["", "abc", "1.not-a-uuid", `x.${crypto.randomUUID()}`, `1.${crypto.randomUUID()}x`]) {
      await expect(listApplications(env, { status: "pending", cursor })).rejects.toMatchObject({ status: 400 });
    }
    await expect(listApplications(env, { status: "unknown", cursor: null } as never)).rejects.toMatchObject({
      status: 400,
    });
    expect(await listApplications(env, { status: "pending", cursor: `99.${crypto.randomUUID()}` })).toEqual({
      applications: [],
      nextCursor: null,
    });
  });
});

describe("reviews", (): void => {
  it("lets only administrators review known applications", async (): Promise<void> => {
    const created = await submit("applicant", { links: [link] });
    await expect(reviewApplication(env, "viewer", { id: created.id, decision: "approved" })).rejects.toMatchObject({
      status: 403,
    });
    await expect(reviewApplication(env, "unverified", { id: created.id, decision: "approved" })).rejects.toMatchObject({
      status: 403,
    });
    await expect(
      reviewApplication(env, "admin", { id: crypto.randomUUID(), decision: "approved" }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(reviewApplication(env, "admin", { id: "bad", decision: "approved" })).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      reviewApplication(env, "admin", { id: created.id, decision: "pending" } as never),
    ).rejects.toMatchObject({ status: 400 });
    expect(await getApplication(env, "applicant")).toMatchObject({ status: "pending", reviewedAt: null });
  });

  it.each(["approved", "rejected"] as const)(
    "records %s decisions",
    async (decision: "approved" | "rejected"): Promise<void> => {
      const created = await submit("applicant", { links: [link] });
      vi.spyOn(Date, "now").mockReturnValue(created.createdAt + 5000);
      const reviewed = await reviewApplication(env, "admin", { id: created.id, decision });
      expect(reviewed).toMatchObject({
        id: created.id,
        status: decision,
        reviewedAt: created.createdAt + 5000,
        updatedAt: created.createdAt + 5000,
      });
      const row = await env.DB.prepare("SELECT reviewed_by FROM streamer_applications WHERE id=?")
        .bind(created.id)
        .first<{ reviewed_by: string }>();
      expect(row?.reviewed_by).toBe("admin");
    },
  );
});

describe("streamer access", (): void => {
  it("describes access for admins, applicants, and viewers", async (): Promise<void> => {
    expect(await getStreamerAccess(env, "viewer")).toEqual({
      admin: false,
      application: null,
      canCreateStreamer: false,
    });
    expect(await getStreamerAccess(env, "admin")).toEqual({ admin: true, application: null, canCreateStreamer: true });
    const created = await submit("applicant", { links: [link] });
    expect(await getStreamerAccess(env, "applicant")).toEqual({
      admin: false,
      application: created,
      canCreateStreamer: false,
    });
    await reviewApplication(env, "admin", { id: created.id, decision: "rejected" });
    expect(await canCreateStreamer(env, "applicant")).toBe(false);
    await reviewApplication(env, "admin", { id: created.id, decision: "approved" });
    expect(await canCreateStreamer(env, "applicant")).toBe(true);
    expect((await getStreamerAccess(env, "applicant")).application?.status).toBe("approved");
  });

  it("gates new streamer profiles behind approval", async (): Promise<void> => {
    const profile = { handle: "applicant", name: "Applicant", about: "" };
    await expect(saveStreamer(env, "applicant", profile)).rejects.toMatchObject({ status: 403 });
    const created = await submit("applicant", { links: [link] });
    await expect(saveStreamer(env, "applicant", profile)).rejects.toMatchObject({ status: 403 });
    expect(await getOwnStreamer(env, "applicant")).toBeNull();

    await reviewApplication(env, "admin", { id: created.id, decision: "approved" });
    const saved = await saveStreamer(env, "applicant", profile);
    expect(saved.handle).toBe("applicant");

    await reviewApplication(env, "admin", { id: created.id, decision: "rejected" });
    const updated = await saveStreamer(env, "applicant", { ...profile, name: "Renamed" });
    expect(updated).toMatchObject({ id: saved.id, name: "Renamed" });
  });

  it("lets administrators create a profile without an application", async (): Promise<void> => {
    const saved = await saveStreamer(env, "admin", { handle: "admin", name: "Admin", about: "" });
    expect(saved.handle).toBe("admin");
    await expect(
      saveStreamer(env, "unverified", { handle: "unverified", name: "Unverified", about: "" }),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe("database constraints", (): void => {
  async function insert(status: string, links: string, reviewedAt: number | null, note = ""): Promise<unknown> {
    return env.DB.prepare(`INSERT INTO streamer_applications (id,user_id,links,note,status,created_at,updated_at,reviewed_at)
      VALUES (?,?,?,?,?,1,1,?)`)
      .bind(crypto.randomUUID(), "applicant", links, note, status, reviewedAt)
      .run();
  }

  it("rejects invalid rows written directly", async (): Promise<void> => {
    const valid = JSON.stringify([link]);
    const tooMany = JSON.stringify(Array.from({ length: 6 }, (_: unknown, index: number) => `${link}${index}`));
    for (const [status, links, reviewedAt, note] of [
      ["waiting", valid, null, ""],
      ["pending", "[]", null, ""],
      ["pending", tooMany, null, ""],
      ["pending", "not json", null, ""],
      ["pending", '{"a":1}', null, ""],
      ["pending", valid, null, "a".repeat(1001)],
      ["pending", valid, 1, ""],
      ["approved", valid, null, ""],
      ["rejected", valid, null, ""],
    ] as const) {
      await expect(insert(status, links, reviewedAt, note)).rejects.toThrow(/CHECK constraint failed/u);
    }
    await expect(insert("approved", valid, 1)).resolves.toBeDefined();
    await expect(insert("pending", valid, null)).rejects.toThrow(/UNIQUE constraint failed/u);
  });

  it("removes applications with their user and keeps reviews when the reviewer leaves", async (): Promise<void> => {
    const created = await submit("applicant", { links: [link] });
    await reviewApplication(env, "admin", { id: created.id, decision: "approved" });
    await env.DB.prepare("DELETE FROM user WHERE id='admin'").run();
    const row = await env.DB.prepare("SELECT status, reviewed_by FROM streamer_applications WHERE id=?")
      .bind(created.id)
      .first<{ status: string; reviewed_by: string | null }>();
    expect(row).toEqual({ status: "approved", reviewed_by: null });
    await env.DB.prepare("DELETE FROM user WHERE id='applicant'").run();
    expect(await getApplication(env, "applicant")).toBeNull();
  });
});

describe("page moderation status", (): void => {
  const pageId = "00000000-0000-4000-8000-0000000000aa";
  const topicId = "00000000-0000-4000-8000-0000000000bb";
  const commentId = "00000000-0000-4000-8000-0000000000cc";
  const anonymous = { owner: false, admin: false };

  // Seed an applicant-owned page with a viewer topic and comment.
  const changedAt = 1_762_300_800_000;
  async function seedPage(status: StreamerStatus): Promise<void> {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO streamers (id,owner_id,handle,name,status,status_reason,status_changed_at) VALUES (?,'applicant','mod_page','Moderated',?,?,?)",
      ).bind(pageId, status, status === "active" ? null : "Repeated spam", status === "active" ? null : changedAt),
      env.DB.prepare(
        "INSERT INTO entries (id,streamer_id,author_id,kind,title,body,category,created_at) VALUES (?,?,'viewer','topic','Topic','Body','Gaming',1)",
      ).bind(topicId, pageId),
      env.DB.prepare(
        "INSERT INTO entry_comments (id,entry_id,author_id,text,created_at) VALUES (?,?,'viewer','Hello',1)",
      ).bind(commentId, topicId),
    ]);
  }

  it("decides writes, visibility and listing from the status alone", (): void => {
    expect(isStreamerWritable("active")).toBe(true);
    expect(isStreamerWritable("frozen")).toBe(false);
    expect(isStreamerWritable("suspended")).toBe(false);
    for (const status of ["active", "frozen"] as const) {
      expect(isStreamerVisible(status, anonymous)).toBe(true);
      expect(isStreamerListed(status)).toBe(true);
    }
    expect(isStreamerVisible("suspended", anonymous)).toBe(false);
    expect(isStreamerVisible("suspended", { owner: true, admin: false })).toBe(true);
    expect(isStreamerVisible("suspended", { owner: false, admin: true })).toBe(true);
    expect(isStreamerListed("suspended")).toBe(false);
  });

  it("active: public and writable for everyone signed in", async (): Promise<void> => {
    await seedPage("active");
    for (const viewer of [null, "viewer", "applicant", "admin"]) {
      await expect(assertStreamerWritable(env, pageId, viewer)).resolves.toMatchObject({ status: "active" });
      expect(await canViewStreamer(env, { ownerId: "applicant", status: "active" }, viewer)).toBe(true);
    }
    expect(await getVisibleStreamer(env, "mod_page", null)).toMatchObject({
      status: "active",
      statusReason: null,
      handleChangedAt: null,
    });
    await expect(mutateEntry(env, "viewer", pageId, { action: "react", id: topicId, value: 1 })).resolves.toEqual({
      id: topicId,
    });
    expect((await listStreamers(env)).streamers.map((page) => page.handle)).toEqual(["mod_page"]);
  });

  it("frozen: public and read-only, the owner included; admins may still remove content", async (): Promise<void> => {
    await seedPage("frozen");
    for (const viewer of [null, "viewer", "applicant", "admin"]) {
      await expect(assertStreamerWritable(env, pageId, viewer)).rejects.toMatchObject({ status: 423 });
    }
    await expect(assertStreamerWritable(env, pageId, "admin", { moderation: true })).resolves.toMatchObject({
      status: "frozen",
    });
    await expect(assertStreamerWritable(env, pageId, "viewer", { moderation: true })).rejects.toMatchObject({
      status: 423,
    });
    // Only owners and admins see the reason and date.
    expect(await getVisibleStreamer(env, "mod_page", null)).toMatchObject({
      status: "frozen",
      statusReason: null,
      statusChangedAt: null,
    });
    expect(await getVisibleStreamer(env, "mod_page", "viewer")).toMatchObject({ statusChangedAt: null });
    expect(await getVisibleStreamer(env, "mod_page", "applicant")).toMatchObject({
      statusReason: "Repeated spam",
      statusChangedAt: changedAt,
    });
    expect(await getVisibleStreamer(env, "mod_page", "admin")).toMatchObject({
      statusReason: "Repeated spam",
      statusChangedAt: changedAt,
    });
    expect((await listStreamers(env)).streamers[0]).toMatchObject({ statusChangedAt: null });
    expect(await getVisibleEntry(env, topicId, null)).toMatchObject({ id: topicId });
    expect((await listStreamers(env)).streamers.map((page) => page.handle)).toEqual(["mod_page"]);
    for (const [user, action] of [
      ["viewer", { action: "react", id: topicId, value: 1 }],
      ["viewer", { action: "comment", id: topicId, text: "Hi" }],
      ["applicant", { action: "create", kind: "choice", title: "Poll", options: ["A", "B"] }],
      ["viewer", { action: "delete", id: topicId }],
    ] as const) {
      await expect(mutateEntry(env, user, pageId, action)).rejects.toMatchObject({ status: 423 });
    }
    await expect(mutateComment(env, "viewer", { action: "like", id: commentId, liked: true })).rejects.toMatchObject({
      status: 423,
    });
    await expect(updateStreamer(env, "applicant", { about: "New" })).rejects.toMatchObject({ status: 423 });
    await expect(
      saveStreamer(env, "applicant", { handle: "mod_page", name: "Moderated", about: "Changed" }),
    ).rejects.toMatchObject({ status: 423 });
    const gate = async (): Promise<{ stepUp: string }> => ({ stepUp: "fresh" });
    await mutateComment(env, "admin", { action: "delete", id: commentId }, gate);
    await mutateEntry(env, "admin", pageId, { action: "delete", id: topicId }, gate);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM entries").first("n")).toBe(0);
  });

  it("suspended: hidden from everyone but the owner and admins, and read-only for all", async (): Promise<void> => {
    await seedPage("suspended");
    await expect(assertStreamerWritable(env, pageId, null)).rejects.toMatchObject({ status: 404 });
    await expect(assertStreamerWritable(env, pageId, "viewer")).rejects.toMatchObject({ status: 404 });
    await expect(assertStreamerWritable(env, pageId, "applicant")).rejects.toMatchObject({ status: 423 });
    await expect(assertStreamerWritable(env, pageId, "admin")).rejects.toMatchObject({ status: 423 });
    await expect(assertStreamerWritable(env, pageId, "admin", { moderation: true })).resolves.toBeDefined();
    expect(await canViewStreamer(env, { ownerId: "applicant", status: "suspended" }, null)).toBe(false);
    expect(await canViewStreamer(env, { ownerId: "applicant", status: "suspended" }, "viewer")).toBe(false);
    expect(await canViewStreamer(env, { ownerId: "applicant", status: "suspended" }, "applicant")).toBe(true);
    expect(await canViewStreamer(env, { ownerId: "applicant", status: "suspended" }, "admin")).toBe(true);
    expect(await getVisibleStreamer(env, "mod_page", null)).toBeNull();
    expect(await getVisibleStreamer(env, "mod_page", "viewer")).toBeNull();
    expect(await getVisibleStreamer(env, "mod_page", "applicant")).toMatchObject({ statusReason: "Repeated spam" });
    expect(await getVisibleStreamer(env, "mod_page", "admin")).toMatchObject({ status: "suspended" });
    expect(await getOwnStreamer(env, "applicant")).toMatchObject({
      status: "suspended",
      statusReason: "Repeated spam",
      statusChangedAt: changedAt,
    });
    expect(await getVisibleEntry(env, topicId, "viewer")).toBeNull();
    expect(await getVisibleEntry(env, topicId, "applicant")).toMatchObject({ id: topicId });
    expect((await listStreamers(env)).streamers).toEqual([]);
    expect((await getOverlaySnapshot(env, pageId, null)).polls).toEqual([]);
    await expect(
      mutateEntry(env, "viewer", pageId, { action: "comment", id: topicId, text: "Hi" }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(mutateEntry(env, "applicant", pageId, { action: "delete", id: topicId })).rejects.toMatchObject({
      status: 423,
    });
  });

  it("treats a missing page as not found", async (): Promise<void> => {
    await expect(assertStreamerWritable(env, pageId, "admin", { moderation: true })).rejects.toMatchObject({
      status: 404,
    });
    expect(await getVisibleStreamer(env, "no_such_page", "admin")).toBeNull();
    expect(await getVisibleStreamer(env, "Bad Handle", "admin")).toBeNull();
    expect(await getVisibleEntry(env, topicId, "admin")).toBeNull();
  });
});
