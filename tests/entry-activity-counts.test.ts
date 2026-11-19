import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AppEnv } from "../app/env";
import { deleteAccount } from "../app/server/account.server";
import { deleteComment, mutateComment } from "../app/server/comments.server";
import { getEntry, getOverlaySnapshot, listEntries, mutateEntry, saveStreamer } from "../app/server/data.server";
import { getOverlayData } from "../app/server/overlay.server";
import type { Entry, Streamer } from "../app/types";
import { createTestDatabase, type TestDatabase } from "./helpers/database";

interface Activity {
  likes: number;
  dislikes: number;
  comments: number;
}

interface SourceRow extends Activity {
  id: string;
  score: number;
}

let database: TestDatabase;
let env: AppEnv;
let streamer: Streamer;

function room(): DurableObjectNamespace {
  return {
    idFromName: (name: string): string => name,
    get: (): { fetch: () => Promise<Response> } => ({
      fetch: (): Promise<Response> => Promise.resolve(new Response(null, { status: 204 })),
    }),
  } as unknown as DurableObjectNamespace;
}

async function seedEntry(kind: "topic" | "choice", createdAt: number): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO entries (id,streamer_id,author_id,kind,title,body,category,options,created_at)
    VALUES (?,?,'owner',?,?,'Details','Gaming',?,?)`)
    .bind(
      id,
      streamer.id,
      kind,
      `Entry ${createdAt}`,
      JSON.stringify(kind === "topic" ? [] : ["One", "Two"]),
      createdAt,
    )
    .run();
  return id;
}

// Counts from the source tables, as the entry query computed them before it read the counts table.
async function sourceRows(): Promise<SourceRow[]> {
  const { results } = await env.DB.prepare(`SELECT e.id,
      (SELECT count(*) FROM entry_reactions r WHERE r.entry_id=e.id AND r.value=1) AS likes,
      (SELECT count(*) FROM entry_reactions r WHERE r.entry_id=e.id AND r.value=-1) AS dislikes,
      (SELECT count(*) FROM entry_comments c WHERE c.entry_id=e.id AND c.removed_at IS NULL) AS comments,
      COALESCE((SELECT sum(value) FROM entry_reactions r WHERE r.entry_id=e.id),0) AS score
    FROM entries e WHERE e.streamer_id=? AND e.kind='topic' ORDER BY score DESC,e.created_at DESC,e.id DESC`)
    .bind(streamer.id)
    .all<SourceRow>();
  return results;
}

function activity(value: Activity): Activity {
  return { likes: value.likes, dislikes: value.dislikes, comments: value.comments };
}

// Every read path agrees with the source tables. Returns the source counts by entry ID.
async function expectAgreement(): Promise<Map<string, Activity>> {
  const source: SourceRow[] = await sourceRows();
  const top = await listEntries(env, streamer, null, { kind: "topics", sort: "top" });
  expect(top.entries.map((entry: Entry): string => entry.id)).toEqual(source.map((row: SourceRow): string => row.id));
  expect(top.entries.map(activity)).toEqual(source.map(activity));
  const overlay = await getOverlayData(env, streamer.id, []);
  const likes = new Map<string, number>(source.map((row: SourceRow): [string, number] => [row.id, row.likes]));
  expect(overlay.topics).toHaveLength(source.length);
  for (const topic of overlay.topics) expect(topic.likes).toBe(likes.get(topic.id));
  for (const row of source) {
    const entry = await getEntry(env, row.id, "viewer");
    expect(entry === null ? null : activity(entry)).toEqual(activity(row));
  }
  return new Map<string, Activity>(source.map((row: SourceRow): [string, Activity] => [row.id, activity(row)]));
}

async function comment(userId: string, entryId: string, parentId: string | null = null): Promise<string> {
  const { id } = await mutateEntry(env, userId, streamer.id, {
    action: "comment",
    id: entryId,
    text: "Hello",
    parentId,
  });
  return id;
}

async function react(userId: string, entryId: string, value: -1 | 0 | 1): Promise<void> {
  await mutateEntry(env, userId, streamer.id, { action: "react", id: entryId, value });
}

beforeAll(async (): Promise<void> => {
  database = await createTestDatabase();
  env = {
    DB: database.db,
    IMAGES: database.bucket,
    CHANNEL_INGEST: room(),
    POLL_ROOMS: room(),
  } as AppEnv;
});

afterAll(async (): Promise<void> => database.dispose());

beforeEach(async (): Promise<void> => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM user"),
    env.DB.prepare("DELETE FROM app_rate_limits"),
    ...["owner", "viewer", "other"].map(
      (id: string): D1PreparedStatement =>
        env.DB.prepare("INSERT INTO user (id,name,email,created_at,updated_at) VALUES (?,?,?,1,1)").bind(
          id,
          id,
          `${id}@example.test`,
        ),
    ),
    env.DB.prepare(`INSERT INTO streamer_applications (id,user_id,links,status,created_at,updated_at,reviewed_at)
      VALUES ('application','owner','["https://example.test/channel"]','approved',1,1,1)`),
  ]);
  streamer = await saveStreamer(env, "owner", { handle: "misha", name: "Misha", about: "" });
});

describe("entry activity counts read from the counts table", (): void => {
  it("match the reaction rows through likes, flips, clears and repeats", async (): Promise<void> => {
    const first = await seedEntry("topic", 1);
    const second = await seedEntry("topic", 2);
    expect((await expectAgreement()).get(first)).toEqual({ likes: 0, dislikes: 0, comments: 0 });
    await react("viewer", first, 1);
    await react("other", first, 1);
    await react("owner", second, -1);
    expect((await expectAgreement()).get(first)).toEqual({ likes: 2, dislikes: 0, comments: 0 });
    await react("viewer", first, -1);
    await react("viewer", first, -1);
    expect((await expectAgreement()).get(first)).toEqual({ likes: 1, dislikes: 1, comments: 0 });
    await react("other", first, 0);
    await react("other", first, 0);
    await react("owner", second, 1);
    const counts = await expectAgreement();
    expect(counts.get(first)).toEqual({ likes: 0, dislikes: 1, comments: 0 });
    expect(counts.get(second)).toEqual({ likes: 1, dislikes: 0, comments: 0 });
  });

  it("match the visible comments through replies, edits, placeholders and removals", async (): Promise<void> => {
    const topic = await seedEntry("topic", 1);
    const parent = await comment("viewer", topic);
    const reply = await comment("other", topic, parent);
    const leaf = await comment("owner", topic);
    expect((await expectAgreement()).get(topic)).toEqual({ likes: 0, dislikes: 0, comments: 3 });
    await mutateComment(env, "other", { action: "edit", id: reply, text: "Edited" });
    await mutateComment(env, "viewer", { action: "like", id: reply, liked: true });
    expect((await expectAgreement()).get(topic)).toEqual({ likes: 0, dislikes: 0, comments: 3 });
    // A comment with replies stays as a removed placeholder and no longer counts.
    await mutateComment(env, "viewer", { action: "delete", id: parent });
    expect(
      await env.DB.prepare("SELECT removed_at IS NOT NULL AS removed FROM entry_comments WHERE id=?")
        .bind(parent)
        .first("removed"),
    ).toBe(1);
    expect((await expectAgreement()).get(topic)).toEqual({ likes: 0, dislikes: 0, comments: 2 });
    // The page owner removes another person's comment; a comment with no replies is deleted.
    await deleteComment(env, "owner", leaf);
    expect((await expectAgreement()).get(topic)).toEqual({ likes: 0, dislikes: 0, comments: 1 });
    // Deleting the last reply also deletes its removed parent, which was not counted.
    await deleteComment(env, "owner", reply);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM entry_comments").first("n")).toBe(0);
    expect((await expectAgreement()).get(topic)).toEqual({ likes: 0, dislikes: 0, comments: 0 });
  });

  it("match the source tables after an account is deleted", async (): Promise<void> => {
    const topic = await seedEntry("topic", 1);
    const other = await seedEntry("topic", 2);
    await react("viewer", topic, 1);
    await react("viewer", other, -1);
    await react("other", topic, -1);
    const parent = await comment("viewer", topic);
    await comment("other", topic, parent);
    await comment("viewer", other);
    // A removed placeholder of another person whose only reply belongs to the deleted account.
    const placeholder = await comment("other", other);
    await comment("viewer", other, placeholder);
    await mutateComment(env, "other", { action: "delete", id: placeholder });
    expect((await expectAgreement()).get(other)).toEqual({ likes: 0, dislikes: 1, comments: 2 });
    await deleteAccount(env, "viewer");
    const counts = await expectAgreement();
    expect(counts.get(topic)).toEqual({ likes: 0, dislikes: 1, comments: 1 });
    expect(counts.get(other)).toEqual({ likes: 0, dislikes: 0, comments: 0 });
  });

  it("leave other entries correct when an entry is deleted, and ignore poll votes", async (): Promise<void> => {
    const topic = await seedEntry("topic", 1);
    const gone = await seedEntry("topic", 2);
    const poll = await seedEntry("choice", 3);
    await react("viewer", topic, 1);
    await react("viewer", gone, 1);
    await comment("viewer", gone);
    await react("other", poll, 1);
    await comment("other", poll);
    await mutateEntry(env, "viewer", streamer.id, { action: "vote", id: poll, choice: 0 });
    await mutateEntry(env, "viewer", streamer.id, { action: "vote", id: poll, choice: 1 });
    await mutateEntry(env, "other", streamer.id, { action: "vote", id: poll, choice: 1 });
    expect(await getEntry(env, poll, null)).toMatchObject({
      likes: 1,
      dislikes: 0,
      comments: 1,
      counts: [0, 2],
      total: 2,
    });
    await mutateEntry(env, "owner", streamer.id, { action: "delete", id: gone });
    expect(await getEntry(env, gone, null)).toBeNull();
    expect(
      await env.DB.prepare("SELECT count(*) AS n FROM entry_activity_counts WHERE entry_id=?").bind(gone).first("n"),
    ).toBe(0);
    expect([...(await expectAgreement()).entries()]).toEqual([[topic, { likes: 1, dislikes: 0, comments: 0 }]]);
  });

  it("show an entry that has no counts row, with zero counts", async (): Promise<void> => {
    const topic = await seedEntry("topic", 1);
    const liked = await seedEntry("topic", 2);
    const poll = await seedEntry("choice", 3);
    await react("viewer", liked, 1);
    await env.DB.prepare("DELETE FROM entry_activity_counts WHERE entry_id IN (?,?)").bind(topic, poll).run();
    const zeros: Activity = { likes: 0, dislikes: 0, comments: 0 };
    expect(await getEntry(env, topic, null)).toMatchObject(zeros);
    expect(await getEntry(env, poll, "viewer")).toMatchObject(zeros);
    for (const sort of ["top", "newest"] as const) {
      const topics = await listEntries(env, streamer, null, { kind: "topics", sort });
      expect(topics.entries.map((entry: Entry): string => entry.id)).toEqual([liked, topic]);
      expect(topics.entries.map(activity)).toEqual([{ likes: 1, dislikes: 0, comments: 0 }, zeros]);
      const polls = await listEntries(env, streamer, null, { kind: "polls", sort });
      expect(polls.entries.map((entry: Entry): string => entry.id)).toEqual([poll]);
    }
    const overlay = await getOverlayData(env, streamer.id, []);
    expect(
      overlay.topics.map((value: { id: string; likes: number }): [string, number] => [value.id, value.likes]),
    ).toEqual([
      [liked, 1],
      [topic, 0],
    ]);
    expect(
      (await getOverlaySnapshot(env, streamer.id, null)).polls.map((value: { id: string }): string => value.id),
    ).toEqual([poll]);
  });
});
