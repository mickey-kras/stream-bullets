import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AppEnv } from "../app/env";
import { BUG_TEMPLATE } from "../app/lib/ideas";
import { isAllowedSupportLink } from "../app/lib/support";
import { orderReplies, orderThreads, replyParent, visibleReplies } from "../app/lib/threads";
import { listCards, saveCards } from "../app/server/community.server";
import { getEntry, listEntries, mutateEntry } from "../app/server/data.server";
import { getSupport, saveSupport } from "../app/server/support.server";
import { communityCardSchema, isCardTarget } from "../app/server/validation";
import type { Comment, CommentThread, Streamer } from "../app/types";
import { createTestDatabase, type TestDatabase } from "./helpers/database";

describe("support link allow-list", (): void => {
  it.each([
    ["kofi", "https://ko-fi.com/nova", true],
    ["kofi", "https://www.ko-fi.com/nova", true],
    ["kofi", "https://ko-fi.com/", false],
    ["kofi", "http://ko-fi.com/nova", false],
    ["kofi", "https://ko-fi.com.evil.example/nova", false],
    ["kofi", "https://evil.example/ko-fi.com/nova", false],
    ["kofi", "https://user:pass@ko-fi.com/nova", false],
    ["kofi", "https://ko-fi.com:8443/nova", false],
    ["patreon", "https://patreon.com/nova", true],
    ["twitch", "https://twitch.tv/subs/nova", true],
    ["twitch", "https://twitch.tv/nova", false],
    ["twitch", "https://twitch.tv/subs/", false],
    ["paypal", "https://paypal.me/nova", true],
    ["paypal", "https://paypal.com/nova", false],
    ["youtube", "https://www.youtube.com/@nova/join", true],
    ["other", "https://merch.example/nova", true],
    ["other", "https://192.168.0.1/tips", false],
    ["other", "javascript:alert(1)", false],
  ] as const)("%s %s → %s", (kind, url, allowed): void => {
    expect(isAllowedSupportLink(kind, url)).toBe(allowed);
  });
});

describe("community card validation", (): void => {
  it("accepts tab targets and https links only", (): void => {
    expect(isCardTarget("tab:topics")).toBe(true);
    expect(isCardTarget("tab:community")).toBe(true);
    expect(isCardTarget("tab:admin")).toBe(false);
    expect(isCardTarget("https://discord.gg/nova")).toBe(true);
    expect(isCardTarget("http://discord.gg/nova")).toBe(false);
    expect(isCardTarget("javascript:alert(1)")).toBe(false);
  });

  it("needs a label and a target together", (): void => {
    const card = { title: "Join", body: "Say hi" };
    expect(communityCardSchema.safeParse(card).success).toBe(true);
    expect(communityCardSchema.safeParse({ ...card, buttonLabel: "Go", buttonTarget: "tab:polls" }).success).toBe(true);
    expect(communityCardSchema.safeParse({ ...card, buttonLabel: "Go" }).success).toBe(false);
    expect(communityCardSchema.safeParse({ ...card, buttonTarget: "tab:polls" }).success).toBe(false);
    expect(communityCardSchema.safeParse({ ...card, icon: "skull" }).success).toBe(false);
    expect(communityCardSchema.safeParse({ ...card, title: "x".repeat(61) }).success).toBe(false);
  });
});

function comment(id: string, createdAt: number, parentId: string | null, extra: Partial<Comment> = {}): Comment {
  return {
    id,
    entryId: "e",
    authorId: id,
    author: id,
    avatar: null,
    text: id,
    createdAt,
    parentId,
    likes: 0,
    liked: false,
    removed: false,
    reported: false,
    ...extra,
  };
}

describe("thread ordering", (): void => {
  it("puts replies oldest first and collapses after two", (): void => {
    const replies = [comment("c", 30, "a"), comment("b", 10, "a"), comment("d", 40, "b"), comment("e", 30, "a")];
    expect(orderReplies(replies).map((reply) => reply.id)).toEqual(["b", "c", "e", "d"]);
    expect(visibleReplies(replies, false)).toMatchObject({ hidden: 2 });
    expect(visibleReplies(replies, false).shown.map((reply) => reply.id)).toEqual(["b", "c"]);
    expect(visibleReplies(replies, true).hidden).toBe(0);
    const thread: CommentThread = { ...comment("a", 1, null), replies };
    expect(replyParent(thread, replies[2])?.id).toBe("b");
    expect(replyParent(thread, replies[0])?.id).toBe("a");
    expect(replyParent(thread, comment("x", 1, "gone"))).toBeNull();
  });

  it("orders top-level comments by the chosen sort", (): void => {
    const threads: CommentThread[] = [
      { ...comment("old", 1, null, { likes: 5 }), replies: [] },
      { ...comment("new", 3, null, { likes: 1 }), replies: [] },
      { ...comment("mid", 2, null, { likes: 5 }), replies: [] },
    ];
    expect(orderThreads(threads, "newest").map((thread) => thread.id)).toEqual(["new", "mid", "old"]);
    expect(orderThreads(threads, "top").map((thread) => thread.id)).toEqual(["mid", "old", "new"]);
  });
});

describe("cards, links and the Ideas board in storage", (): void => {
  let database: TestDatabase;
  let env: AppEnv;
  const page = "11111111-1111-4111-8111-111111111111";
  const official = "22222222-2222-4222-8222-222222222222";

  beforeAll(async (): Promise<void> => {
    database = await createTestDatabase();
    env = { DB: database.db, ADMIN_EMAILS: "admin@example.test" } as AppEnv;
  });
  afterAll(async (): Promise<void> => database.dispose());
  beforeEach(async (): Promise<void> => {
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare("DELETE FROM user"),
      env.DB.prepare("DELETE FROM app_rate_limits"),
      ...["owner", "viewer", "team", "admin"].map((id: string) =>
        env.DB.prepare(
          "INSERT INTO user (id,name,email,email_verified,created_at,updated_at) VALUES (?,?,?,1,?,?)",
        ).bind(id, id, `${id}@example.test`, now, now),
      ),
      env.DB.prepare("INSERT INTO streamers (id,owner_id,handle,name) VALUES (?,'owner','nova','Nova')").bind(page),
      env.DB.prepare(
        "INSERT INTO streamers (id,owner_id,handle,name,is_official) VALUES (?,'team','streambullets','StreamBullets',1)",
      ).bind(official),
    ]);
  });

  const card = (title: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    icon: null,
    title,
    body: "Text",
    buttonLabel: null,
    buttonTarget: null,
    ...extra,
  });

  it("shows defaults until the first save, then replaces the ordered list atomically", async (): Promise<void> => {
    expect(await listCards(env, page)).toBeNull();
    const saved = await saveCards(env, "owner", {
      cards: [card("One", { buttonLabel: "Topics", buttonTarget: "tab:topics" }), card("Two", { icon: "discord" })],
    });
    expect(saved?.map((value) => value.title)).toEqual(["One", "Two"]);
    await saveCards(env, "owner", { cards: [card("Two"), card("One")] });
    expect((await listCards(env, page))?.map((value) => value.title)).toEqual(["Two", "One"]);
    await expect(
      saveCards(env, "owner", { cards: Array.from({ length: 9 }, (_, i) => card(`C${i}`)) }),
    ).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      saveCards(env, "owner", { cards: [card("Bad", { buttonLabel: "Go", buttonTarget: "javascript:x" })] }),
    ).rejects.toMatchObject({
      status: 400,
    });
    await expect(saveCards(env, "viewer", { cards: [] })).rejects.toMatchObject({ status: 403 });
    expect((await listCards(env, page))?.map((value) => value.title)).toEqual(["Two", "One"]);
    await env.DB.prepare("UPDATE streamers SET status='frozen' WHERE id=?").bind(page).run();
    await expect(saveCards(env, "owner", { cards: [] })).rejects.toMatchObject({ status: 423 });
  });

  it("saves up to four support links on their providers' domains", async (): Promise<void> => {
    expect(await getSupport(env, page)).toEqual({ links: [], visible: true, card: false });
    const saved = await saveSupport(env, "owner", {
      links: [
        { kind: "kofi", label: "ignored", url: "https://ko-fi.com/nova" },
        { kind: "other", label: "Merch", url: "https://merch.example/nova" },
      ],
      visible: true,
      card: true,
    });
    expect(saved.links.map((link) => [link.kind, link.label])).toEqual([
      ["kofi", null],
      ["other", "Merch"],
    ]);
    expect(saved.card).toBe(true);
    await expect(
      saveSupport(env, "owner", {
        links: [{ kind: "patreon", label: null, url: "https://ko-fi.com/nova" }],
        visible: true,
        card: false,
      }),
    ).rejects.toMatchObject({ status: 400, message: expect.stringContaining("Patreon") });
    await expect(
      saveSupport(env, "owner", {
        links: [{ kind: "other", label: null, url: "https://merch.example/x" }],
        visible: true,
        card: false,
      }),
    ).rejects.toMatchObject({ status: 400 });
    const five = Array.from({ length: 5 }, () => ({ kind: "kofi", label: null, url: "https://ko-fi.com/nova" }));
    await expect(saveSupport(env, "owner", { links: five, visible: true, card: false })).rejects.toMatchObject({
      status: 400,
    });
  });

  it("files new ideas under review, checks categories and the bug template, and limits author deletes", async (): Promise<void> => {
    const officialPage = { id: official, handle: "streambullets" } as Streamer;
    await expect(
      mutateEntry(env, "viewer", official, {
        action: "create",
        kind: "topic",
        title: "Idea",
        body: "Body",
        category: "Gaming",
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      mutateEntry(env, "viewer", page, {
        action: "create",
        kind: "topic",
        title: "Topic",
        body: "Body",
        category: "feature",
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      mutateEntry(env, "viewer", official, {
        action: "create",
        kind: "topic",
        title: "Bug",
        body: BUG_TEMPLATE,
        category: "bug",
      }),
    ).rejects.toMatchObject({ status: 400 });
    const { id } = await mutateEntry(env, "viewer", official, {
      action: "create",
      kind: "topic",
      title: "Week view bug",
      body: `${BUG_TEMPLATE}Open the week view.`,
      category: "bug",
    });
    expect(await getEntry(env, id, "viewer")).toMatchObject({ status: "review", category: "bug", reported: false });
    const second = await mutateEntry(env, "viewer", official, {
      action: "create",
      kind: "topic",
      title: "Light theme",
      body: "Please",
      category: "design",
    });
    await env.DB.prepare("UPDATE entries SET status='planned' WHERE id=?").bind(second.id).run();
    const filtered = await listEntries(env, officialPage, null, {
      kind: "topics",
      sort: "top",
      query: "",
      cursor: null,
      status: "planned",
    });
    expect(filtered.entries.map((entry) => entry.title)).toEqual(["Light theme"]);
    // An idea from before statuses existed has none, and is listed as new.
    await env.DB.prepare(
      "INSERT INTO entries (id,streamer_id,author_id,kind,title,body,category,created_at) VALUES (?,?,'viewer','topic','Old idea','b','design',1)",
    )
      .bind(crypto.randomUUID(), official)
      .run();
    const review = await listEntries(env, officialPage, null, {
      kind: "topics",
      sort: "top",
      query: "",
      cursor: null,
      status: "review",
    });
    expect(review.entries.map((entry) => entry.title).sort()).toEqual(["Old idea", "Week view bug"]);
    await expect(mutateEntry(env, "viewer", official, { action: "delete", id: second.id })).rejects.toMatchObject({
      status: 403,
    });
    await mutateEntry(env, "team", official, { action: "delete", id: second.id });
    await mutateEntry(env, "viewer", official, { action: "delete", id });
    expect(await getEntry(env, id, "viewer")).toBeNull();
  });
});
